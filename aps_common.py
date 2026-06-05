"""Shared helpers for the APS (Autodesk Platform Services, formerly Forge) viewer.

Holds the tiny pieces the pipeline script and the Flask server both need:
a minimal .env loader, the 2-legged OAuth v2 token call, and the objectId->URN
encoding. Everything talks to the APS REST API directly via `requests` so there
are no SDK version surprises.
"""
import os
import base64
import requests

# Single APS host for auth, OSS and Model Derivative.
BASE = "https://developer.api.autodesk.com"

HERE = os.path.dirname(os.path.abspath(__file__))
_PLACEHOLDERS = ("your-client-id-here", "your-client-secret-here", "")


def load_env(path=None):
    """Read APS_* values from forge-viewer/.env (without clobbering real env vars).

    Returns (client_id, client_secret). Exits with a clear message if they are
    still the placeholders from .env.example.
    """
    if path is None:
        path = os.path.join(HERE, ".env")
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

    cid = os.environ.get("APS_CLIENT_ID", "")
    sec = os.environ.get("APS_CLIENT_SECRET", "")
    if cid in _PLACEHOLDERS or sec in _PLACEHOLDERS:
        raise SystemExit(
            "APS credentials missing. Edit forge-viewer/.env and set APS_CLIENT_ID "
            "and APS_CLIENT_SECRET (from https://aps.autodesk.com/myapps)."
        )
    return cid, sec


def get_token(client_id, client_secret, scopes):
    """Fetch a 2-legged (client-credentials) OAuth v2 token. Returns (token, expires_in)."""
    resp = requests.post(
        f"{BASE}/authentication/v2/token",
        auth=(client_id, client_secret),  # HTTP Basic: base64(id:secret)
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        data={"grant_type": "client_credentials", "scope": " ".join(scopes)},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    return body["access_token"], body["expires_in"]


def object_id_to_urn(object_id):
    """Base64url-encode an OSS objectId (urn:adsk.objects:os.object:...) for Model Derivative."""
    return base64.urlsafe_b64encode(object_id.encode()).decode().rstrip("=")
