# Face Recognition Service — Fly.io deployment

This directory packages `server/scripts/face_service.py` (DeepFace ArcFace +
RetinaFace + the gallery JSON) into a Docker image and deploys it on Fly.io,
so the Vercel-hosted Node app can call `${FACE_SERVICE_URL}/recognize`.

## Why Fly.io
- 2 GB shared-CPU VM costs ~$5/mo (and the first $5/mo of usage is free).
- One-command Docker deploys, stable HTTPS URL, region next to Vercel.
- Models (~240 MB) are pre-baked into the image so cold starts don't stall on
  weight downloads.

## One-time setup

1. Install flyctl: <https://fly.io/docs/flyctl/install/> — on Windows PowerShell:

   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```

2. Log in (opens browser):

   ```bash
   fly auth login
   ```

3. From the **repo root** (not from `face-service/`), launch the app. Fly will
   pick a globally-unique name and rewrite `app =` in `fly.toml` for you:

   ```bash
   fly launch --config face-service/fly.toml --copy-config --no-deploy
   ```

   Accept the defaults; the only thing that matters is the app name (write it
   down — that becomes part of the URL: `https://<app>.fly.dev`).

## Deploy

From the **repo root** (so the Dockerfile's `COPY server/...` paths resolve):

```bash
fly deploy . --config face-service/fly.toml \
             --dockerfile face-service/Dockerfile \
             --ignorefile face-service/.flyignore \
             --remote-only
```

First build takes ~6–8 min (TF wheel + model download bake). Subsequent
deploys are ~2 min thanks to layer caching. Watch logs with
`fly logs --app <app-name>`.

## Verify

```bash
curl https://<app>.fly.dev/health
# { "ok": true, "gallery_size": <N>, "characters": [...], "threshold": 0.45 }
```

## Wire it into Vercel

In your Vercel project → Settings → Environment Variables, add:

```
FACE_SERVICE_URL = https://<app>.fly.dev
```

(Apply to Production + Preview.) Redeploy the Vercel project once so the
new env var is picked up. `agent.js:851` will now route face recognition
through Fly instead of falling back to Gemini.

## Cost knobs

`fly.toml` keeps **one machine warm** (`min_machines_running = 1`) so the
Node-side 3 s timeout never trips. Costs ~$5/mo.

To save money, flip these in `fly.toml`:

```toml
auto_stop_machines = "stop"
min_machines_running = 0
```

…and bump the timeout in `server/agent.js:859`:

```js
signal: AbortSignal.timeout(8000),  // was 3000
```

Cold start with pre-baked weights is ~4–6 s, so 8 s leaves a buffer. Trade-off:
the first frame after idle takes a few seconds; everything afterwards is hot.

## Updating the gallery

When you rebuild `face_gallery.json` (via `server/scripts/build_face_gallery.py`),
just commit and `fly deploy` again. The image rebuild only re-COPYs the JSON
(weights are cached above the COPY layer).

## Context-aware recognition

`POST /recognize` accepts an optional `candidate_character_ids` array. When
present, ArcFace searches only those character embeddings first. The Node app
builds this list from the current scene slice (`characters_on_screen`,
`characters`) and falls back to nearby slices only when the current slice has no
character data. This keeps ambiguous faces from being compared against the whole
show-wide gallery.
