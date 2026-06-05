#!/usr/bin/env python3
"""Upload + translate one Revit model into the APS viewer, and register it in models.json.

Steps (current OSS v2 + Model Derivative REST API):
  1. authenticate (2-legged)   2. ensure a persistent bucket
  3. upload the .rvt (direct-to-S3 signed flow)
  4. submit an SVF2 translation   5. poll the manifest until success
  6. upsert the model into models.json (the list the viewer's dropdown reads)

Usage:
  python3 aps_pipeline.py                                  # default: LOD 300 final
  python3 aps_pipeline.py --path "../LOD 200 MODEL Group 2.rvt" \
          --id lod200 --name "LOD 200" --object LOD200.rvt
"""
import os
import re
import json
import time
import argparse

import requests

from aps_common import BASE, HERE, load_env, get_token, object_id_to_urn

PIPELINE_SCOPES = ["data:read", "data:write", "data:create", "bucket:create", "bucket:read"]

DEFAULT_MODEL = os.path.join(os.path.dirname(HERE), "LOD 300 FINAL MODEL Group 2.rvt")
MODELS_FILE = os.path.join(HERE, "models.json")
LEGACY_FILE = os.path.join(HERE, "model.json")

# Stable dropdown order (lower = listed first); unknown ids fall to the end.
ORDER = {"lod100": 0, "lod200": 1, "lod300": 2}


def sanitize_bucket(client_id):
    """Bucket keys are global + lowercase + [a-z0-9-_.]. Derive a stable one from the client id."""
    base = re.sub(r"[^a-z0-9]", "", client_id.lower())[:100]
    return f"{base}-bimviewer"


def ensure_bucket(token, bucket_key, region):
    resp = requests.post(
        f"{BASE}/oss/v2/buckets",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "x-ads-region": region},
        json={"bucketKey": bucket_key, "policyKey": "persistent"},
        timeout=30,
    )
    if resp.status_code in (200, 201):
        print(f"  bucket created : {bucket_key}")
    elif resp.status_code == 409:
        print(f"  bucket exists  : {bucket_key}")
    else:
        raise SystemExit(f"Bucket error {resp.status_code}: {resp.text[:300]}")


def upload(token, bucket_key, object_key, file_path):
    """Direct-to-S3 signed upload (single part) -> returns the OSS objectId."""
    auth = {"Authorization": f"Bearer {token}"}

    signed = requests.get(
        f"{BASE}/oss/v2/buckets/{bucket_key}/objects/{object_key}/signeds3upload",
        headers=auth, params={"parts": 1}, timeout=30,
    )
    signed.raise_for_status()
    info = signed.json()

    size = os.path.getsize(file_path)
    print(f"  uploading      : {size / 1e6:.1f} MB ...")
    with open(file_path, "rb") as fh:
        put = requests.put(info["urls"][0], data=fh.read(), timeout=900)
    put.raise_for_status()

    done = requests.post(
        f"{BASE}/oss/v2/buckets/{bucket_key}/objects/{object_key}/signeds3upload",
        headers={**auth, "Content-Type": "application/json"},
        json={"uploadKey": info["uploadKey"]}, timeout=60,
    )
    done.raise_for_status()
    return done.json()["objectId"]


def translate(token, urn, region):
    resp = requests.post(
        f"{BASE}/modelderivative/v2/designdata/job",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "x-ads-force": "true"},
        json={"input": {"urn": urn},
              "output": {"destination": {"region": region},
                         "formats": [{"type": "svf2", "views": ["2d", "3d"]}]}},
        timeout=60,
    )
    resp.raise_for_status()
    print("  translation job submitted")


def poll(token, urn, interval=10, timeout=2400):
    auth = {"Authorization": f"Bearer {token}"}
    start = time.time()
    while True:
        resp = requests.get(f"{BASE}/modelderivative/v2/designdata/{urn}/manifest",
                            headers=auth, timeout=30)
        if resp.status_code == 404:
            print("  translate      : initializing ...")
        else:
            resp.raise_for_status()
            manifest = resp.json()
            status = manifest.get("status")
            print(f"  translate      : {status} ({manifest.get('progress', '')})")
            if status == "success":
                return
            if status in ("failed", "timeout"):
                raise SystemExit("Translation " + status + ": "
                                 + json.dumps(manifest.get("derivatives", manifest))[:800])
        if time.time() - start > timeout:
            raise SystemExit(f"Gave up waiting after {timeout}s.")
        time.sleep(interval)


def load_models():
    """Read models.json; migrate a legacy single-model model.json if that's all we have."""
    if os.path.exists(MODELS_FILE):
        with open(MODELS_FILE) as fh:
            return json.load(fh)
    if os.path.exists(LEGACY_FILE):
        with open(LEGACY_FILE) as fh:
            legacy = json.load(fh)
        legacy.setdefault("id", "lod300")
        legacy["name"] = "LOD 300"
        return [legacy]
    return []


def save_models(models):
    models.sort(key=lambda m: (ORDER.get(m.get("id"), 99), m.get("name", "")))
    with open(MODELS_FILE, "w") as fh:
        json.dump(models, fh, indent=2)


def main():
    ap = argparse.ArgumentParser(description="Upload + translate a Revit model for the viewer.")
    ap.add_argument("--path", default=DEFAULT_MODEL, help="path to the .rvt/.ifc file")
    ap.add_argument("--id", default="lod300", help="short id used in the URL/dropdown")
    ap.add_argument("--name", default="LOD 300", help="label shown in the dropdown")
    ap.add_argument("--object", dest="object_key", default="LOD300_FINAL.rvt",
                    help="OSS object key (filename in the bucket)")
    args = ap.parse_args()

    client_id, client_secret = load_env()
    region = os.environ.get("APS_REGION", "US").upper()
    bucket_key = os.environ.get("APS_BUCKET") or sanitize_bucket(client_id)

    if not os.path.exists(args.path):
        raise SystemExit(f"Model not found: {args.path}")

    print(f"Model  : {args.path}")
    print(f"Id/name: {args.id} / {args.name}")
    print(f"Region : {region}")

    token, _ = get_token(client_id, client_secret, PIPELINE_SCOPES)
    ensure_bucket(token, bucket_key, region)
    object_id = upload(token, bucket_key, args.object_key, args.path)
    urn = object_id_to_urn(object_id)
    print(f"  urn            : {urn}")
    translate(token, urn, region)
    poll(token, urn)

    entry = {"id": args.id, "name": args.name, "urn": urn,
             "bucket": bucket_key, "object": args.object_key, "region": region}
    models = [m for m in load_models() if m.get("id") != entry["id"]]
    models.append(entry)
    save_models(models)
    print(f"\nDone. models.json now lists {len(models)} model(s): "
          + ", ".join(m["id"] for m in models))
    print("Start / restart:  python3 server.py")


if __name__ == "__main__":
    main()
