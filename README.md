# Paras render server — free deployment guide

This is the ffmpeg-based video assembly service for the Shayan Paras channel pipeline.
It takes scene images + narration + music and returns a finished MP4 with Ken Burns motion,
branding, subscribe/like CTA overlay, and burned-in captions.

## Deploy in ~15 minutes, completely free (Render.com free tier)

1. **Create a GitHub repo**
   - Go to github.com → New repository → name it e.g. `paras-render-server` → keep it private if you like.
   - Upload these 4 files to it: `server.js`, `package.json`, `Dockerfile`, `README.md`.

2. **Sign up at render.com** (free, no credit card required for the free web service tier).

3. **New → Web Service**
   - Connect your GitHub account, select the `paras-render-server` repo.
   - Environment: **Docker** (Render will detect the Dockerfile automatically).
   - Instance type: **Free**.
   - Click **Create Web Service**.

4. Render will build and deploy. Once live, you'll get a public URL like:
   `https://paras-render-server.onrender.com`

5. **Set an environment variable** in Render's dashboard (Settings → Environment):
   - `BASE_URL` = the exact URL from step 4 (so the server can return correct download links).

6. That's it. Test it by sending a POST request to `https://your-app.onrender.com/render` with a
   small JSON payload (I'll wire this call up directly from n8n once it's live — just send me the URL).

## Notes
- Render's free tier spins the server down after 15 minutes of inactivity and takes ~30-60 seconds
  to wake up on the next request — totally fine since this only runs when a video is being rendered.
- Free tier has no fixed cost and no time limit. Only limitation is it's not built for 24/7 uptime,
  which we don't need here.
- If you outgrow it later (more videos, faster renders), you can upgrade Render's paid tier — but
  it's not required to make this work.
