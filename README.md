# Withings Sleep for Homey Pro

Bed presence from the Withings Sleep Analyzer, built to survive the failure that
kills the official integration.

## Why this exists

Withings' notification API uses a **separate subscription per data category**
(`appli`). The official Homey app subscribes once at pair time and never checks
again. When the bed-in (`50`) and bed-out (`51`) subscriptions lapse, weight
(`appli 1`) keeps flowing, the OAuth token stays valid, and the device looks
perfectly healthy in Homey's developer tools — but the bed triggers never fire
again, with nothing anywhere reporting an error.

This app verifies both bed subscriptions on a timer and recreates any that have
vanished, exposing the subscription state as a capability so the failure is
visible instead of silent.

## Screenshots

<p>
  <a href="docs/screenshots/device.jpg"><img src="docs/screenshots/device.jpg" alt="Device view" width="250"></a>
  <a href="docs/screenshots/insights.jpg"><img src="docs/screenshots/insights.jpg" alt="Insights" width="250"></a>
  <a href="docs/screenshots/timeline.jpg"><img src="docs/screenshots/timeline.jpg" alt="Timeline" width="250"></a>
</p>

## Setup

**This section is for running the app from source, or for using your own
Withings application instead of the built-in one.** People who install from the
Homey App Store add the device and sign in; the app owner's credentials reach
the app through `Homey.env`, uploaded with the build and never packed into the
archive.

Note that `Homey.env` does reach a published build, but reads empty on Homey
Pro 13.4.0 in a devkit install (`homey app run --remote` and `homey app
install`). For local development, enter the same values on the app's settings
page, which override the environment.

Do the steps in this order, since the Withings application needs the webhook
ID: registering the webhook first saves a round trip.

### 1. Register a Homey webhook

At [tools.developer.homey.app/webhooks](https://tools.developer.homey.app/webhooks),
create a new webhook and pick **Query Parameter** as the matching strategy.
That is what makes `?homey=<homeyId>` route an incoming POST to the right
Homey. Copy its ID and secret into `env.json`.

This gives Withings a public HTTPS endpoint to POST to. Withings requires a
real domain on port 443 that answers `HEAD` with a 2xx — Athom's webhook
service satisfies this.

Without it the app still works, but falls back to polling and loses realtime
triggering.

### 2. Register a Withings application

At [developer.withings.com/dashboard/create](https://developer.withings.com/dashboard/create),
create a **Public API integration**. The other integration types are only
available under contract.

Register **both** of these URLs on the application:

```
https://callback.athom.com/oauth2/callback/
https://webhooks.athom.com/webhook/<WEBHOOK_ID>
```

The first is the OAuth redirect. The trailing slash on it matters:
`WITHINGS_REDIRECT_URI` sends the slashed form, and Withings compares that one
byte for byte.

The second is the webhook base. Every installation subscribes with its own
Homey appended as a query parameter:

```
https://webhooks.athom.com/webhook/<WEBHOOK_ID>/?homey=<HOMEY_ID>
```

Registering the base covers all of them, which is what makes one Withings
application usable by more than one Homey — the webhook ID is per app, the
Homey ID is per install. If a subscription is ever rejected as an unregistered
URL, add the full form with your own Homey ID as well.

Copy the client ID and secret into `env.json`. The secret is shown once; use
**Renew** on the application's overview page if you lose it or need to rotate.

The app requests the `user.info`, `user.metrics`, `user.activity` and
`user.sleepevents` scopes. **`user.sleepevents` is the one that carries
bed-in/bed-out** — without it the subscriptions succeed but no events are ever
delivered. `user.activity` is what the polling fallback needs; without it the
`v2/sleep` call returns 403 while the webhook path keeps working.

### 3. Fill in `env.json`

```json
{
  "WITHINGS_CLIENT_ID": "...",
  "WITHINGS_CLIENT_SECRET": "...",
  "WEBHOOK_ID": "...",
  "WEBHOOK_SECRET": "..."
}
```

`env.json` is the only place the app owner's credentials live, for both
development and publishing. It is gitignored; `env.json.example` is the
template.

**The CLI keeps these values out of the app archive.** `homey app run`,
`install` and `publish` each read `env.json` separately and deliver its
contents to the running app as `Homey.env` — inside an `App` subclass that is
`this.homey.env`. The archive itself never contains the file, so no secret
ships in a published build. `.homeyignore` states the exclusion explicitly
rather than relying on the CLI's defaults.

`app.js` resolves each key as an app-settings override first, then `Homey.env`.
There is no third source and no credentials compiled into the source tree.

### 4. Verify

Open the app's settings and press **Test connection**. It asks Withings for a
nonce — the same signed call the app makes when refreshing a token, so a wrong
secret fails there exactly as it would in use — and sends `HEAD` to the webhook
the way Withings does before accepting a subscription. It also reports which
source supplied the credentials, without revealing them.

The settings page carries the same instructions in a collapsible guide, so you
do not need this file while setting up. It works from the phone — the guide
prints the subscription URL with a copy button — but a desktop browser at
[tools.developer.homey.app/apps](https://tools.developer.homey.app/apps) makes
pasting long keys easier, and you will be in a browser at Withings anyway.

## How it works

```
Sleep Analyzer → Withings cloud → webhook (appli 50/51)
                                     ↓
              https://webhooks.athom.com/webhook/<WEBHOOK_ID>?homey=<homeyId>
                                     ↓
                          Homey → flow triggers
```

A poll of the sleep series runs alongside as a safety net, and a subscription
check runs every few hours (configurable per device).

### OAuth notes

Withings' token endpoint is not plain OAuth2: every call to `/v2/oauth2` needs
an `action=requesttoken` parameter plus a `nonce` fetched from `/v2/signature`,
and both requests carry an HMAC-SHA256 signature over their parameters sorted by
name and joined with commas. `lib/withings-api.js` handles this; it is the part
most third-party clients get wrong.

Access tokens last 3 hours, refresh tokens 1 year.

## Flow cards

| Type | Card |
| --- | --- |
| Trigger | Someone gets into bed |
| Trigger | Someone gets out of bed |
| Trigger | The Withings notification subscription is lost |
| Condition | Someone is / isn't in bed |
| Action | Renew the Withings notification subscription |

The third trigger is the point: if the subscription ever lapses again, you get
told rather than discovering it weeks later.

## Development

```bash
npm test                    # node --test, no network
npm run validate            # homey app validate
homey app run --remote      # upload to the Homey Pro and run there
```

Use `--remote`. Without it, CLI v4 builds the app into a local Docker container
and requires Docker Desktop to be running; `--remote` uploads straight to the
Homey Pro instead and needs no Docker.

## Publishing

The app is at 1.7.6 and passes `homey app validate --level publish`.

```bash
npm test
npm run validate            # publish level
homey app publish
```

`homey app publish` uploads a build to the Homey App Store and opens it for
Athom's review. The version in `app.json` must be bumped for every submission,
and every version needs a matching entry in `.homeychangelog.json`.

One thing is still open before a broad release:

- **Withings API mode.** The Withings application backing the app is in
  development mode, which caps it at ten linked users. Lifting that requires
  the callback URL to satisfy Withings' rules for a production application.
