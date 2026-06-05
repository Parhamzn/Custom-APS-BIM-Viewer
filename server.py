#!/usr/bin/env python3
"""Tiny Flask server for the BIM viewer.

  GET /api/token   -> a short-lived PUBLIC token (viewables:read only) for the browser
  GET /api/models  -> the list of translated models (id, name, urn, region) for the dropdown
The client secret never leaves this process.
"""
import os
import json
import time

from flask import Flask, jsonify, send_from_directory

from aps_common import HERE, load_env, get_token

CLIENT_ID, CLIENT_SECRET = load_env()
VIEWER_SCOPES = ["viewables:read"]  # the only scope the browser is trusted with

app = Flask(__name__, static_folder="static", static_url_path="/static")

_cache = {"token": None, "expires_at": 0.0}


def read_models():
    models_path = os.path.join(HERE, "models.json")
    if os.path.exists(models_path):
        with open(models_path) as fh:
            return json.load(fh)
    legacy_path = os.path.join(HERE, "model.json")  # pre-dropdown single-model file
    if os.path.exists(legacy_path):
        with open(legacy_path) as fh:
            legacy = json.load(fh)
        legacy.setdefault("id", "lod300")
        legacy["name"] = "LOD 300"
        return [legacy]
    return []


@app.route("/api/token")
def api_token():
    now = time.time()
    if not _cache["token"] or now > _cache["expires_at"] - 60:
        token, ttl = get_token(CLIENT_ID, CLIENT_SECRET, VIEWER_SCOPES)
        _cache["token"] = token
        _cache["expires_at"] = now + ttl
    return jsonify({"access_token": _cache["token"],
                    "expires_in": int(_cache["expires_at"] - now)})


@app.route("/api/models")
def api_models():
    models = read_models()
    if not models:
        return jsonify({"error": "no models yet — run: python3 aps_pipeline.py"}), 404
    return jsonify(models)


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    print("BIM viewer running at  http://localhost:8080")
    app.run(host="127.0.0.1", port=8080, debug=False)
