# Attribution Bridge

Self-hosted web app that lets GHL leads copied from a master sub-account into
broker sub-accounts **pass Assistable's DNC attribution check** — no Assistable
backend changes required.

## One-click deploy (recommended)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Hari487-coder/attribution-bridge)

Click the button, sign in to Render (GitHub/Google), and it provisions the app
on **your own Render account** with a permanent HTTPS URL and a persistent
disk for your configuration and opt-out registry. Uses the ~$7/mo starter
instance (required for the persistent disk — the free tier wipes your broker
tokens and compliance records on every restart). Your API tokens live only on
your instance; nothing passes through anyone else's infrastructure.

After it deploys: open the URL, go to **Setup**, set a dashboard password and
webhook key FIRST, then add your master + broker accounts.

## The problem it solves

Assistable allows an outbound AI call to a national-DNC-registered number only
when the GHL contact carries opt-in evidence: populated `attributionSource`,
populated `lastAttributionSource`, or `createdBy.source === "INTEGRATION"`.
GHL's native **Copy Contact** action produces a record with none of these, so
copied opt-in leads get blocked (`Number on national DNC list`).

Contacts **created through an API integration** get the `INTEGRATION` stamp.
This app replaces Copy Contact with an API create.

## What it does

| Feature | What happens |
|---|---|
| **/webhook/lead** | Master GHL workflow posts `{contact_id, broker_key}` → app fetches the master contact, creates it in the mapped broker location via the GHL API (create, never upsert), verifies the stamp, logs the result. |
| **Pre-check** | Simulates Assistable's exact gate (DND → attribution evidence → FreeDNCList national registry) for a phone/contact — the "dry-run DNC verification" — without placing a call. |
| **Channel test** | Creates + inspects + deletes a throwaway contact per broker to empirically confirm which `createdBy.source` your token type produces. |
| **Bulk import** | Scans your **master** account, shows which contacts are opted-in, and (after a dry run) pushes selected ones into a broker through the verify-first pipeline — for onboarding a broker or backfilling leads from before the webhook. |
| **Backlog migration** | Scans a broker for contacts that fail the evidence check, then (after a dry run) deletes + recreates them through the API channel. |

## Run

```bash
npm install
node server.js          # http://localhost:3344
MOCK=1 node server.js   # demo mode, no GHL credentials needed
```

Windows PowerShell: `$env:MOCK='1'; node server.js`

## Setup

1. **Setup tab** — master location ID + API token, one row per broker
   (key / location ID / token), a long random webhook key, and a dashboard
   password if the app will be exposed publicly.
2. **Channel test** each broker. If the stamp isn't `INTEGRATION` for your
   token type, use a GHL OAuth-app connection for that broker instead
   (e.g. a Make/Zapier GHL connection) and re-test.
3. **Master GHL workflow**: replace Copy Contact with a Webhook action —
   `POST https://<host>/webhook/lead?key=<webhook key>` with body
   `{"contact_id": "{{contact.id}}", "broker_key": "<key>"}`.
4. Verify one lead end-to-end, then migrate the backlog.

## Hosting

GHL needs HTTPS reachability: `cloudflared tunnel --url http://localhost:3344`
for a quick tunnel, or deploy to Render/Railway (single `node server.js`, no
build step). `data/config.json` holds tokens — keep it out of git (see
.gitignore) and set the dashboard password before exposing.

## Honest limits

- The pre-check replicates the platform hard-DNC list, per-contact DND,
  attribution evidence, and the national registry. It **cannot** see Assistable's
  internal per-subaccount DNC list (recorded opt-outs) or the imported-number
  bypass tenant setting — those can still change the real outcome, and the
  simulator says so in its `caveats`.
- `createdBy` is immutable → backlog fix requires delete + recreate, which
  discards that contact's conversation/appointment history in the broker
  location. Migrate only un-worked contacts.
- **Delete safety:** every destructive recreate logs a full `pre-delete-backup`
  snapshot to `data/activity.jsonl` *before* deleting, and migration skips any
  contact that shares a phone with a sibling (which would collide on GHL dedupe
  and lose the record). If a create fails after a delete, the result carries a
  `recovery` note pointing at the snapshot.
- Standard fields, tags, and fieldKey-matched custom fields are preserved;
  notes/tasks/conversations are not.
- GHL-side behavior (which token types earn the INTEGRATION stamp) is verified
  empirically by the Channel test, not assumed.

## Verified attribution registry

The bridge refuses to distribute a lead unless its **master** record shows genuine
opt-in (attribution / a real Meta-IG integration / not-DND) — fields GHL sets and
the customer can't forge. Each verification is HMAC-signed, workspace-scoped, and
stored in `data/registry.json`. An **opt-out always wins**: withdrawals are sticky
and never auto-resurrected, and are re-checked immediately before every write.
Assistable does not read the signature — enforcement is the refusal plus the
`INTEGRATION` stamp; the signed note is an audit trail and a forward-compat hook.

- **Set your country code.** `settings.defaultCallingCode` (Setup tab, digits only)
  canonicalizes registry keys so a national-format opt-out (`07700900123`) matches
  an E.164 master record (`+447700900123`). Default `1` (US/Canada). Set it to your
  country or international opt-outs sent in national format may not match.
- **Clearing an opt-out** is deliberately manual (safety): remove the entry from
  `data/registry.json`. There is no auto re-opt-in path.
- Wire GHL's STOP/opt-out workflow to `POST /webhook/optout` with `{phone}` (or
  `{contact_id}`) to feed opt-outs automatically.

## Tests

`MOCK=1 node test/smoke.js` — 27 checks covering the compliance port, phone-format
matching, distribute+verify, recreate, channel test, concurrent-webhook
serialization, and the full verification model (verify-first refusal, opt-out wins
incl. international cross-format, sticky withdrawals, signature tamper-detection,
junk-input rejection). Exit 0 = all pass.
