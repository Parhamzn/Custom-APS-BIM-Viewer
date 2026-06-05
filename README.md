# BIM Viewer (Autodesk Platform Services)

Revives the 2021 ETH IBI Master Project web viewer: it uploads the Revit model to
Autodesk Platform Services (APS, formerly Forge), translates it to the SVF2 viewer
format, and serves it in the browser with the Autodesk Viewer SDK.

## Architecture

```
aps_pipeline.py   one-time: auth -> bucket -> S3 upload -> translate -> poll -> model.json
server.py         Flask: serves the page + /api/token (read-only) + /api/model
static/           the viewer web page (index.html, main.js, style.css)
.env              your APS_CLIENT_ID / APS_CLIENT_SECRET   (gitignored)
```

The Client Secret stays on the server. The browser only ever receives a short-lived
token scoped `viewables:read`.

## Setup

Requires Python 3 with `flask` and `requests` (already installed on this machine).

1. **Add credentials.** Edit `.env` and set `APS_CLIENT_ID` and `APS_CLIENT_SECRET`
   from https://aps.autodesk.com/myapps (no callback URL needed — this uses
   2-legged auth).

2. **Upload + translate the model** (one time, ~5–15 min for the 49 MB LOD 300 file):

   ```bash
   python3 aps_pipeline.py
   ```

   This writes `model.json` with the model's URN.

3. **Run the viewer:**

   ```bash
   python3 server.py
   ```

   Open http://localhost:8080

## Notes

- Default model is `../LOD 300 FINAL MODEL Group 2.rvt`. Point `APS_MODEL_PATH` at the
  LOD 200 file (or any `.rvt`/`.ifc`) to translate a different one.
- If your APS account is in the EMEA region, set `APS_REGION=EMEA` in `.env`.
- The bucket is `persistent`, so you only upload once; re-running the pipeline just
  re-translates.
