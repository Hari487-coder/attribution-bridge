# Attribution Bridge

Self-hosted web app that lets GHL leads copied from a master sub-account into
broker sub-accounts **pass CastigliaAI's DNC attribution check** — no CastigliaAI
backend changes required.

## One-click deploy (recommended)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Hari487-coder/attribution-bridge)

Click the button, sign in to Render (GitHub/Google), and it provisions the app
on **your own Render account** with a permanent HTTPS URL and a persistent
disk for your configuration and opt-out registry. Uses the ~$7/mo starter
instance (required for the persistent disk — the free tier wipes your broker
tokens and compliance records on every restart). Your API tokens live only on
your instance; nothing passes through anyone else's infrastructure.

After it deploys: open the URL and **sign in as the super-admin**. Set
`SUPERADMIN_USER` / `SUPERADMIN_PASS` as env vars before first boot to choose
those credentials; if you don't, a random password is generated and printed to
the logs on first boot (search the deploy log for `seeded super-admin`). From the
super-admin account picker you create one account per team / lead vendor — each
gets its own isolated instance (its own master, brokers, opt-out registry, and
webhook key). See **Accounts & login** below.

## The problem it solves

CastigliaAI allows an outbound AI call to a national-DNC-registered number only
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
| **Pre-check** | Simulates CastigliaAI's exact gate (DND → attribution evidence → FreeDNCList national registry) for a phone/contact — the "dry-run DNC verification" — without placing a call. |
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

## Accounts & login

The app is multi-tenant. Everyone signs in; there is no open dashboard.

- **Super-admin** (one account, seeded from `SUPERADMIN_USER`/`SUPERADMIN_PASS`)
  sees an **account picker**: create/disable accounts, reset passwords, and
  **Open** any account to view or configure its instance. There are no account
  limits.
- **User accounts** (one per team / lead vendor) each get a fully isolated
  instance — their own master + brokers, opt-out registry, activity log, and
  **webhook key**. They can only see their own data, never anyone else's.
- **Webhooks route by key.** `POST /webhook/lead?key=<that account's webhook
  key>` is delivered to that account's instance. Keys are globally unique, so an
  existing GHL workflow keeps working unchanged. No cookie is involved.
- Upgrading an older single-tenant install? On first boot it is migrated
  automatically into an account named **valor** (its old dashboard password
  becomes valor's login password, or set `VALOR_PASS`). Nothing is lost.

## Setup

1. **Sign in**, then (super-admin) **Open** the account you're configuring.
2. **Setup tab** — master location ID + API token, one row per broker
   (key / location ID / token), and a long random webhook key unique to this
   account.
3. **Channel test** each broker. If the stamp isn't `INTEGRATION` for your
   token type, use a GHL OAuth-app connection for that broker instead
   (e.g. a Make/Zapier GHL connection) and re-test.
4. **Master GHL workflow**: replace Copy Contact with a Webhook action —
   `POST https://<host>/webhook/lead?key=<webhook key>` with body
   `{"contact_id": "{{contact.id}}", "broker_key": "<key>"}`.
5. Verify one lead end-to-end, then migrate the backlog.

## Hosting

GHL needs HTTPS reachability: `cloudflared tunnel --url http://localhost:3344`
for a quick tunnel, or deploy to Render/Railway (single `node server.js`, no
build step). Per-account data (tokens, opt-out registry) lives under `DATA_DIR`
(default `./data`; set it to a persistent disk in production, e.g. `/var/data`
on Render) in `accounts.json` + `tenants/<account>/…` — keep it out of git (see
.gitignore). Access is gated by login, so set `SUPERADMIN_PASS` before exposing.

**Environment variables:** `PORT`, `DATA_DIR`, `SUPERADMIN_USER` /
`SUPERADMIN_PASS` (super-admin login, seeded on first boot), `VALOR_PASS`
(optional, sets the migrated legacy account's password), `PLATFORM_DNC`
(comma-separated numbers the dialer never calls — set it to match the platform's
hard-DNC list so the bridge refuses to bridge them too; private, not in the repo),
`MOCK=1` (demo, no GHL calls).

## Honest limits

- The pre-check replicates the platform hard-DNC list, per-contact DND,
  attribution evidence, and the national registry. It **cannot** see CastigliaAI's
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
marketing attribution (a populated `attributionSource` / `lastAttributionSource`
with a real source/medium value) and is not DND or opted out. **Stricter than the
dialer on purpose:** a bare `createdBy.source = "INTEGRATION"` stamp is NOT
accepted, because that stamp is also what a cold-list API import carries. Junk
attribution (empty or non-string values like `{x:false}`) is rejected too. Each
verification is HMAC-signed, workspace-scoped, and stored per account in
`data/tenants/<account>/registry.json`. An **opt-out always wins**: withdrawals
are sticky and never auto-resurrected, are re-checked immediately before every
write, and now also set any **already-bridged broker copies to Do-Not-Call** so
the dialer stops on contacts created before the opt-out (not just future ones).
The dialer does not read the signature — enforcement is the refusal plus the
`INTEGRATION` stamp; the signed note is an audit trail and a forward-compat hook.

- **Suppression list (the in-app DNC backstop).** `settings.suppressionList` (Setup
  tab, one number per line) is refused BEFORE attribution is even considered and
  re-checked before every write, so those numbers are never bridged no matter how
  clean their attribution looks. Load reassigned numbers (RND), known litigators,
  prior complainers, and any internal do-not-contact set here. Empty = off. This
  is the independent safety net that stops attribution alone from being the only
  thing between a bad number and the dialer.
- **Consent recency (optional).** `settings.maxConsentAgeDays` (0 = off) refuses a
  lead whose master record is older than N days — a proxy for stale consent that
  keys off GHL's `dateAdded`, not a true consent timestamp.
- **Separation of concerns — the bridge does NOT look up DNC.** National DNC,
  internal DNC, and telephony compliance belong to the platform; duplicating them
  here would only drift when the platform changes provider/exemption/state logic.
  The bridge owns **attribution + consent verification, audit, and broker creation**.
  Its `internal DNC` (opt-out + suppression) is enforced *absolutely, before
  attribution* — but as the bridge's own opt-out ledger, not a copy of the
  platform's engine. National-DNC status is **recorded** on the consent record only
  when an authoritative source passes it in (`national_dnc` in the webhook body);
  the bridge never queries a registry itself.
- **Tamper-evidence + content ID.** Each consent record carries `sig` (HMAC under
  the workspace key — the real tamper-evidence) and `hash` (keyless SHA-256 of the
  canonical payload — a stable content ID for referencing/correlating, not a
  security control on its own), plus `bridgeVersion` for provenance.
- **Set your country code.** `settings.defaultCallingCode` (Setup tab, digits only)
  canonicalizes registry keys so a national-format opt-out (`07700900123`) matches
  an E.164 master record (`+447700900123`). Default `1` (US/Canada). Set it to your
  country or international opt-outs sent in national format may not match.
- **Clearing an opt-out** is deliberately manual (safety): remove the entry from
  that account's `data/tenants/<account>/registry.json`. No auto re-opt-in path.
- Wire GHL's STOP/opt-out workflow to `POST /webhook/optout` with `{phone}` (or
  `{contact_id}`) to feed opt-outs automatically.

### Verifiable consent record (so the dialer doesn't have to trust the bridge)

Every bridged contact gets a signed **consent record** written as a note, so the
platform (or a compliance auditor) can confirm the opt-in *independently* instead
of trusting the `INTEGRATION` stamp. The note carries a human line plus a machine
block:

```
CastigliaAI attribution verified via master account | evidence=first_touch | source=utmSource=ig, medium=paid | master=<loc>/<contactId> | at=<iso>
<consent b64="1">eyJ2IjoxLCJwaG9uZ…</consent>
```

The `<consent>` block is base64 of the exact signed record
`{v,phone,evidence,source:{field,values},master:{locationId,contactId},workspace,verifiedAt,sig}`
(base64 so no attribution value can break the delimiter or the signed bytes). The
HMAC `sig` covers every field including the nested `source` and `master`.

**Independent verification protocol** (no secret needed — this is the point):
1. Read + base64-decode the `<consent>` block off the bridged contact (or `GET /api/verify/consent?phone=…`).
2. **Re-fetch the referenced `master.contactId` from GHL and confirm it still shows the same attribution and is not DND/opted-out.** GHL sets `attributionSource`/`createdBy`; the customer cannot forge them via the update API, so this is the authoritative, unforgeable check. `GET /api/verify/consent?phone=…&recheck=1` does exactly this live.
3. The HMAC `sig` is a tamper-evidence bonus (validates under the workspace key); the master re-check above is what actually proves consent.

This is the groundwork for platform-side enforcement: when the dialer verifies
consent server-side, the evidence is already on every contact.

### Observability (the Report tab)

The bridge's job is to *prove* what happened, not to decide who can be called.
The Report tab provides:
- **Verification report** — enter a number, get its consent evidence, a Stripe-style
  event **timeline** (created → verified → migrated → opted-out → suppressed), and
  the decision, with a **Print / Save PDF** button. The artifact you hand to
  support or a customer. (`GET /api/report?phone=`)
- **Explain a decision** — runs every gate (not short-circuit) and lists *all*
  reasons a master contact would or wouldn't bridge. (`POST /api/verify/explain`)
- **Audit integrity** — the activity log is a **tamper-evident hash chain**: each
  event carries `sha256(prevHash + body)`, so deleting or editing any past event
  breaks every hash after it. Verify it in one click. (`GET /api/audit/verify`)

### Webhook hardening

- **Replay protection (idempotency).** A duplicate delivery (GHL retry or a
  replayed request) for the same `contact → broker` within a 10-minute window is
  a no-op, so it can't create a duplicate or churn a "recreate"-policy contact.
  A `event_id` / `idempotency_key` in the body tightens the key when supplied.
- **Optional HMAC signing.** Set `settings.webhookSigningSecret` (Setup tab) and
  `/webhook/*` then requires `X-Bridge-Timestamp` + `X-Bridge-Signature`
  (HMAC-SHA256 of `` `${timestamp}.${rawBody}` ``) within 5 minutes — stronger
  auth than the shared key and blocks replay. GHL's native webhook can't sign,
  so leave it blank for GHL and use it for code-capable callers.
- **Trusted attribution allowlist.** `settings.trustedAttributionSources` — when
  set, a lead is bridged only if its attribution values contain one of these
  tokens, hardening the master-as-trust-anchor against forged/untrusted
  attribution. Empty = accept any genuine attribution. (The strict gate already
  blocks the easy vector by requiring a real `attributionSource`, not a bare
  INTEGRATION stamp.)

## Tests

- `MOCK=1 node test/smoke.js` — 146 checks: the compliance port, phone-format
  matching, distribute+verify, recreate, channel test, concurrent-webhook
  serialization, Tier-1 ops (backup/restore/digest), the strict evidence gate
  (INTEGRATION-only + junk attribution refused), the suppression backstop (RND/
  litigator list refused despite attribution, across formats, re-checked before
  write) + consent recency, the registry-poisoning bypass regression, opt-out DND
  propagation to broker copies, and the full verification model (verify-first
  refusal, opt-out wins incl. international cross-format, sticky withdrawals,
  signature tamper-detection, junk-input rejection).
- `node test/multitenant.js` — 29 checks: tenant config/registry isolation,
  login + session sign/verify (tamper-resistant), webhook-key routing +
  uniqueness, disabled-tenant handling, super-admin guards.
- `node test/migration.js` — 14 checks: the legacy → `valor` migration
  (files moved, account seeded from the old password, config intact, idempotent).

Exit 0 = all pass. The multi-tenant/migration suites each use a throwaway
`DATA_DIR`, so run them as separate `node` processes.
