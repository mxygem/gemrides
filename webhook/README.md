# Ride-preference webhook

Receives Tally's webhook for the ride-preference form at `POST /tally/ride-pref`
and sends Gem a notification. Runs on Fly.io; no dependencies.

## Deploy

```sh
cd webhook
fly launch --no-deploy --copy-config   # keep or change the app name in fly.toml
fly secrets set TALLY_SIGNING_SECRET=...  # from Tally's webhook settings

# Notifier: one or both
fly secrets set NTFY_TOPIC=some-long-unguessable-topic        # push via the ntfy app
fly secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
                TWILIO_FROM=+1... NOTIFY_TO=+1...             # SMS via Twilio
fly deploy
```

Then, in Tally: form → Integrations → Webhooks → endpoint
`https://<app>.fly.dev/tally/ride-pref`, and add a signing secret
(the same value as `TALLY_SIGNING_SECRET`).

If every configured notifier fails, the endpoint returns 502 so Tally retries.

## Test

```sh
npm test
```
