# Vercel Deployment Guide — NYC Home Rehab Dashboard

## Prerequisites

- A [Vercel account](https://vercel.com) (free tier is sufficient)
- The project already pushed to GitHub (connected via Manus GitHub integration)
- Your Supabase project URL and service_role key ready

---

## Step 1 — Import the GitHub Repository into Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **"Import Git Repository"**
3. Select your GitHub account and find the `clinic-dashboard` repository
4. Click **Import**

---

## Step 2 — Configure the Build Settings

On the "Configure Project" screen, set the following:

| Setting | Value |
|---|---|
| **Framework Preset** | Other |
| **Root Directory** | `.` (leave as default) |
| **Build Command** | `pnpm install --frozen-lockfile && pnpm build` |
| **Output Directory** | `dist` |
| **Install Command** | `pnpm install --frozen-lockfile` |
| **Node.js Version** | 20.x |

> Vercel will also read these settings automatically from `vercel.json` in the project root.

---

## Step 3 — Add Environment Variables

In the Vercel project settings under **Settings → Environment Variables**, add **all** of the following:

### Required — Supabase

| Variable | Value | Where to find it |
|---|---|---|
| `SUPABASE_URL` | `https://czjckcplzuigjbhegbon.supabase.co` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` (service_role key) | Supabase → Settings → API → service_role |

### Required — Authentication & Security

| Variable | Value | Notes |
|---|---|---|
| `JWT_SECRET` | A long random string (32+ chars) | Used to sign session cookies. Generate with: `openssl rand -base64 32` |
| `NODE_ENV` | `production` | Tells the server to serve static files instead of Vite dev server |

### Required — Manus OAuth (if using Manus login)

| Variable | Notes |
|---|---|
| `VITE_APP_ID` | Your Manus OAuth application ID |
| `OAUTH_SERVER_URL` | Manus OAuth backend base URL |
| `VITE_OAUTH_PORTAL_URL` | Manus login portal URL |
| `OWNER_OPEN_ID` | Owner's Manus open ID |
| `OWNER_NAME` | Owner's name |

> **Note:** If you are only using the clinic username/password login (`jeromerivera123`/`nychomerehab`), the Manus OAuth variables are optional. The clinic login will work without them.

### Optional — Manus Built-in APIs

| Variable | Notes |
|---|---|
| `BUILT_IN_FORGE_API_URL` | Only needed if using LLM, image generation, or storage features |
| `BUILT_IN_FORGE_API_KEY` | Server-side Manus API key |
| `VITE_FRONTEND_FORGE_API_KEY` | Frontend Manus API key |
| `VITE_FRONTEND_FORGE_API_URL` | Frontend Manus API URL |

---

## Step 4 — Deploy

Click **Deploy**. Vercel will:
1. Install dependencies with `pnpm install --frozen-lockfile`
2. Build the React frontend with Vite → outputs to `dist/`
3. Bundle the Express server with esbuild → outputs to `api/server.js`
4. Deploy both as a single serverless function

The deployment takes approximately 2–3 minutes.

---

## Step 5 — Verify Supabase Connection in Production

After deployment, open your Vercel URL and:

1. Navigate to `/login`
2. Enter `jeromerivera123` / `nychomerehab`
3. If login succeeds → Supabase connection is working correctly

If login fails, check:
- Vercel → **Functions** tab → click the function → view logs for any `[Supabase]` error messages
- Confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set correctly (service_role, NOT anon key)

---

## Step 6 — Custom Domain (Optional)

1. In Vercel → **Settings → Domains**
2. Add your custom domain (e.g., `dashboard.nychomerehab.com`)
3. Follow Vercel's DNS instructions to point your domain

---

## Architecture Notes

This project uses **Express + tRPC** (not Next.js). On Vercel it runs as a single serverless Node.js function (`api/server.ts`) that:
- Handles all `/api/trpc/*` requests (tRPC procedures)
- Handles `/api/oauth/*` routes (Manus OAuth)
- Handles `/manus-storage/*` requests (storage proxy)
- Serves the Vite-built React frontend for all other routes

**Limitations on Vercel:**
- Serverless functions have a **30-second timeout** (configured in `vercel.json`)
- No persistent in-memory state between requests (this app has none — all state is in Supabase)
- Cold starts may add 1–2 seconds to the first request after inactivity

---

## Alternative: Keep Using Manus Hosting

Your dashboard is already live at **[nychomerehab.manus.space](https://nychomerehab.manus.space)** with:
- Zero configuration required
- Built-in SSL
- Custom domain support
- No cold starts
- Automatic deployments via the Manus Publish button

Manus hosting is the recommended option for this project.
