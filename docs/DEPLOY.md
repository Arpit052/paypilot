# Deploying the public demo

There are two options below: [Render](#render) and [Azure App Service](#azure-app-service). Each takes about 10–15 minutes.

## What visitors get

- The link opens on the setup screen. One click on **Try the demo** loads sample data; there's no sign-up.
- Every visitor gets a **private copy**, so nobody sees anyone else's invoices, settings or keys.
- A visitor can connect **their own** PayPal sandbox keys in Settings → PayPal and send real sandbox invoices. Their keys stay in their copy only.
- Copies nobody has opened for 3 days are deleted.

## Render

Render uses the `render.yaml` blueprint in this repo, on the free plan.

1. **Create a Render account** at render.com. Signing in with GitHub is easiest.
2. In the Render dashboard click **New → Blueprint**.
3. **Connect the GitHub repo** `paypilot` and select it. Render reads `render.yaml` and shows one web service called `paypilot`.
4. Render asks for the values marked `sync: false`. There is only one:
   - `GEMINI_API_KEY`: a key from [Google AI Studio](https://aistudio.google.com/apikey). Use a **new** key just for the demo.

   Do **not** add PayPal keys. The demo doesn't need them, because visitors use demo mode or their own sandbox.
5. Click **Apply**. The first build takes 2–4 minutes. When the log shows `PayPilot running`, open the URL Render gives you (something like `https://paypilot-xxxx.onrender.com`).
6. **Test it in a private browser window:**
   - The landing page opens. **Open PayPilot** shows the setup screen, and **Try the demo** opens the dashboard.
   - A second private window gets its own separate copy.
   - The setup screen says it's your own private copy, and there's no passcode box.

## Before judging (Render)

- **The free plan sleeps** after 15 minutes without visitors. The next visit then takes about a minute to wake it up. Open the link a few minutes before anyone looks at it. Better, set a free uptime monitor (for example UptimeRobot) to visit `https://<your-app>/api/health` every 10 minutes. You can also switch the service to the Starter plan for the judging period.
- **The free plan's disk is wiped** on every restart or redeploy. With visitor copies this only means everyone starts fresh, which is fine for a demo.
- **Gemini free tier** has a daily limit. If many people use the Assistant at once and the limit is reached, the app shows a calm message and everything except the AI keeps working.

## Updating

Every push to the `main` branch on GitHub redeploys automatically. To change a setting, open the service in Render → **Environment**, edit it, then click **Save changes**.

## Azure App Service

PayPilot runs on App Service's built-in Node.js on Linux with no changes. When it sees Azure (`WEBSITE_SITE_NAME`), it listens on all interfaces, keeps its data in `/home/data` (the only folder that survives restarts and redeploys), and builds public links from the site's address.

**Which plan.** The Free plan (F1) allows 60 CPU minutes a day. When that runs out, Azure stops the app and every visitor gets an error until midnight UTC, which is a real risk during judging. Use **Basic B1** for the judging week instead (about $0.02 an hour, so a few dollars for a week). The [Azure for Students](https://azure.microsoft.com/free/students) $100 credit, which needs no card, or the free-account credit covers it.

1. **Create the web app.** In the [Azure portal](https://portal.azure.com) go to **Create a resource → Web App** and fill in:
   - **Resource group:** new, `paypilot-rg`.
   - **Name:** for example `paypilot-demo`. The address becomes `https://paypilot-demo.azurewebsites.net`; some regions add a short suffix.
   - **Publish:** Code.
   - **Runtime stack:** Node 22 LTS (Node 24 LTS also works).
   - **Operating system:** Linux.
   - **Region:** one near you, e.g. Central India.
   - **Pricing plan:** Basic B1.

   Then click **Review + create → Create**.
2. **Connect GitHub.** Open the new app → **Deployment Center** → Source **GitHub** → sign in → Organization `Arpit052`, Repository `paypilot`, Branch `main` → **Save**. Azure adds a workflow file to the repo (`.github/workflows/main_<app>.yml`) and deploys. Every push to `main` deploys again. You can watch it under the repo's **Actions** tab, or in Deployment Center → Logs.
3. **Add the settings.** Open the app → **Settings → Environment variables → App settings**, add each of these with **+ Add**, then **Apply**:

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | a **new** key from Google AI Studio |
   | `HOSTED_DEMO` | `1` |
   | `VISITOR_WORKSPACES` | `1` |
   | `BUSINESS_NAME` | `Ortiz Design Studio` |
   | `DEFAULT_CURRENCY` | `USD` |
   | `APP_TIMEZONE` | `America/New_York` |

   Do **not** add PayPal keys or `APP_PASSWORD`.
4. **Startup and health.**
   - **Settings → Configuration → General settings:** set **Startup Command** to `node server.js`, turn **Always on** on (B1 and up), then **Save**.
   - **Monitoring → Health check:** turn it on with path `/api/health`.
5. **Test it.** Open `https://<your-app>.azurewebsites.net` in a private window and check that **Open PayPilot** shows the setup screen and **Try the demo** opens the dashboard. If something is wrong, look at **Monitoring → Log stream**. A healthy start prints `PayPilot running`.

**If the page says "Application Error"**, open Log stream:
- `node:sqlite` errors mean the runtime is older than Node 22.13. Set the runtime to Node 22 LTS or 24 LTS under Configuration.
- A missing module means the build didn't run. Open the repo's Actions tab and re-run the deploy workflow.

**After judging**, scale the plan down or delete the resource group `paypilot-rg`, so the credit isn't used up.

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
