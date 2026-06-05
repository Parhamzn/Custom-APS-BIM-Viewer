# Custom APS BIM Viewer

**▶ Live demo: https://custom-aps-bim-viewer.onrender.com**

A web-based BIM viewer for the **ETH Zürich IBI Master Project** — *"Climate Neutral &
Circular Buildings through a Digitally Enabled Framework"* (Group 2, 2021). It streams the
project's Revit models from **Autodesk Platform Services** (APS, formerly Forge) and overlays
the building's **material-passport** data — embodied carbon, lifespan, reuse/recycling
potential, manufacturers, and more — directly onto the 3D model.

## Features

- **Model switcher** — LOD 200 and LOD 300, each opening at a consistent isometric view.
- **Color by** — shade every element by a passport metric (embodied CO₂, lifespan, reused,
  reuse/recycling potential, waste, U-value, number of elements, building layer, connection
  type), with report-accurate fixed thresholds and a legend.
- **Summary** — aggregate by building layer / design / material / Revit category × measure
  (total CO₂, count, avg lifespan/reuse) as a donut + bar chart; click a group to isolate it
  in 3D. Embodied CO₂ comes out **net-negative** (the timber structure stores carbon), so it
  uses diverging bars.
- **Filter** — show/hide elements by building layer and building design.
- **Click-to-inspect** — a consolidated passport panel per element (materials, manufacturer,
  CO₂, lifespan, reuse/recycle/waste, …), merged from the model and the spreadsheet passport.
- **Wood skin** — the timber columns and slabs render in the pergola's wood tone in
  original-colors mode.

The passport from `Components, properties and material passport.xlsx` is parsed into
`static/passport.json` and joined to model elements (by Building Design, with family-name
aliases) to fill in data the Revit model itself is missing.

## Architecture

| File | Role |
|------|------|
| `server.py` | Flask app — serves the page, issues a read-only `viewables:read` token (`/api/token`; the Client Secret never reaches the browser), and the model list (`/api/models`). |
| `static/` | Viewer UI (Autodesk Viewer v7 SDK) + `passport.json`. |
| `aps_pipeline.py` | One-time tool — upload a `.rvt` to APS, translate to SVF2, register it in `models.json`. |
| `aps_common.py` | Shared APS auth / OSS / URN helpers. |

The browser only ever receives a short-lived, view-only token; the Client Secret stays on the
server.

## Run locally

Requires Python 3 with `flask` + `requests`.

1. Copy `.env.example` to `.env` and set `APS_CLIENT_ID` / `APS_CLIENT_SECRET` from
   <https://aps.autodesk.com/myapps> (2-legged auth — no callback URL needed).
2. *(First time only, to add/translate a model)* `python3 aps_pipeline.py --path "../Some Model.rvt" --id lodXXX --name "LOD XXX" --object LODXXX.rvt`
3. `python3 server.py` → <http://localhost:8080>

## Deploy

Hosted on **Render** (free tier). `requirements.txt` + `Procfile`
(`gunicorn server:app --bind 0.0.0.0:$PORT`) drive the build, and the **Client ID/Secret are
set as Render environment variables** — never committed (`.env` is gitignored). Pushing to
`main` auto-redeploys. The models are already translated in APS cloud storage, so no re-upload
is needed on deploy.

---

*ETH Zürich, Institut für Bau- und Infrastrukturmanagement (IBI) — Master Project, Group 2, 2021.*
