# Deploying the public demo

These steps put PayPilot online on [Render](https://render.com) with a free plan, using the `render.yaml` blueprint in this repo. It takes about 10 minutes.

## What visitors get

- The link opens straight into a working dashboard with sample data. There's no sign-up or setup form.
- Every visitor gets a **private copy**, so nobody sees anyone else's invoices, settings or keys.
- A visitor can connect **their own** PayPal sandbox keys in Settings → PayPal and send real sandbox invoices. Their keys stay in their copy only.
- Copies nobody has opened for 3 days are deleted.

## Steps

1. **Create a Render account** at render.com. Signing in with GitHub is easiest.
2. In the Render dashboard click **New → Blueprint**.
3. **Connect the GitHub repo** `paypilot` and select it. Render reads `render.yaml` and shows one web service called `paypilot`.
4. Render asks for the values marked `sync: false`. There is only one:
   - `GEMINI_API_KEY`: a key from [Google AI Studio](https://aistudio.google.com/apikey). Use a **new** key just for the demo.

   Do **not** add PayPal keys. The demo doesn't need them, because visitors use demo mode or their own sandbox.
5. Click **Apply**. The first build takes 2–4 minutes. When the log shows `PayPilot running`, open the URL Render gives you (something like `https://paypilot-xxxx.onrender.com`).
6. **Test it in a private browser window:**
   - The landing page opens. **Open PayPilot** goes straight to the dashboard.
   - A second private window gets its own separate copy.
   - The note at the top says "This is your own private copy".

## Before judging

- **The free plan sleeps** after 15 minutes without visitors. The next visit then takes about a minute to wake it up. Open the link a few minutes before anyone looks at it. Better, set a free uptime monitor (for example UptimeRobot) to visit `https://<your-app>/api/health` every 10 minutes. You can also switch the service to the Starter plan for the judging period.
- **The free plan's disk is wiped** on every restart or redeploy. With visitor copies this only means everyone starts fresh, which is fine for a demo.
- **Gemini free tier** has a daily limit. If many people use the Assistant at once and the limit is reached, the app shows a calm message and everything except the AI keeps working.

## Updating

Every push to the `main` branch on GitHub redeploys automatically. To change a setting, open the service in Render → **Environment**, edit it, then click **Save changes**.

## Optional settings

| Variable | What it does |
|---|---|
| `BUSINESS_NAME` | The business name on sample data (default `Ortiz Design Studio`) |
| `APP_TIMEZONE` | Time zone for due dates (default `America/New_York`) |
| `MAX_WORKSPACES` | Most visitor copies kept at once (default 400; the oldest are removed first) |
| `APP_PASSWORD` | Ask for a passcode before the app opens. Leave it empty for judges. |

## Security notes

- The server never uses its own `.env` PayPal keys inside a visitor's copy, even if some are set.
- A visitor's copy is identified by a random 128-bit id in an HttpOnly cookie. It never appears in a URL.
- Links a client opens (unlock and receipt pages) carry their own random tokens and only show that one invoice.
