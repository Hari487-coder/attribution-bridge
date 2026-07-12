# Attribution Bridge — Multi-Tenant / Login-Based Platform

**Date:** 2026-07-11
**Status:** Approved design → spec for review
**Author:** Hari + Claude (for Anthony Castiglia / CastigliaAI)

## 1. Goal & context

Today the Attribution Bridge is **single-tenant**: one `config.json`, one
`registry.json`, one `activity.jsonl`, one admin Basic-auth password, all under a
single `DATA_DIR` on Anthony's Render disk. It is **live in production** — bridging
real leads (178+ and counting) across brokers rebecca / shamark / michael via the
webhook, plus the SOP/Tier-1/backlog features.

Anthony wants to open the tool to **other teams and lead vendors in his agency**:
each gets a **login** to their **own isolated instance** of Master/Brokers, with
their own registry, activity, backups, digest/alerts, and webhook — fully walled
off from every other account.

**Hard constraint:** the existing live instance and its GHL webhook must keep
running with **zero disruption**. It becomes a normal account named **"Valor"**.

## 2. Roles

- **Super-admin (Anthony):** one top-level login. Manages accounts (create,
  disable, reset password) and can **"open"** any account to view/manage it. Has
  no bridge of its own — it oversees. Sees a list of all accounts.
- **Account / user (tenant):** one login (shared within a team/vendor). A fully
  isolated instance: own Master/Brokers config, verification registry, activity
  log, backups, scheduler state, settings, and webhook. **No limits.**

One login per account (a team shares its login). Individual named users per person
are **out of scope** for v1 (see §12).

## 3. Accounts & authentication

### 3.1 Account store — `data/accounts.json` (top-level, outside any tenant)

```jsonc
{
  "sessionSecret": "<hex>",          // HMAC secret for signing session cookies (auto-generated once)
  "accounts": {
    "<accountId>": {
      "id": "<accountId>",           // slug, e.g. "valor", "team-b"
      "label": "Valor",              // display name
      "role": "user",                // "super" | "user"
      "passwordHash": "<hex>",       // scrypt(password, salt)
      "passwordSalt": "<hex>",
      "tenantId": "<accountId>",     // folder under data/tenants/ (super-admin has none)
      "disabled": false,
      "createdAt": "<iso>"
    }
  }
}
```

### 3.2 Passwords
Hashed with Node's built-in `crypto.scryptSync(password, salt, 64)` + a per-account
random salt. **No new dependency.** Constant-time compare on login.

### 3.3 Sessions
- Login page (`GET /login`, `POST /login`). On success set an **HTTP-only,
  SameSite=Lax, Secure** cookie `ab_session` = `base64(payload).hmac`, where
  `payload = { accountId, role, activeTenant, iat }` signed with `sessionSecret`
  (same HMAC technique the app already uses for verification markers).
- Sessions are stateless signed tokens (no server-side session store needed).
  Expiry via `iat` + a max-age (e.g. 14 days). Logout clears the cookie.
- Replaces the current Basic-auth prompt entirely.

### 3.4 Super-admin "open account"
Super-admin's session carries `role: "super"`. An **Open** action on an account
sets `activeTenant` in a re-signed cookie; from then on every dashboard/API call
operates on that tenant. A visible banner ("Viewing: Valor — exit") + a one-click
return to the account list. Super-admin can only ever act within one tenant at a
time (each instance managed separately, per Anthony).

## 4. Data model / storage — file-per-tenant

Extends the current file-based model; **no database, no new infrastructure**, works
on the existing Render persistent disk (`DATA_DIR=/var/data`).

```
<DATA_DIR>/
  accounts.json                       # logins (§3.1)
  tenants/
    valor/                            # the migrated live instance
      config.json                     # master, brokers, settings, webhookKey, signingSecret
      registry.json                   # verification / opt-out records
      activity.jsonl                  # activity log
      scheduler.json                  # digest/alert watermark state
      backups/                        # rotating snapshots
    team-b/
      config.json ...
```

Each tenant folder holds **exactly the file set the app uses today** — the schema
of each file is unchanged. Only their *location* becomes per-tenant.

## 5. Tenant resolution (how a request finds its data)

- **Dashboard + `/api/*` requests:** session cookie → account → `activeTenant`
  → tenant folder. All store/verify/backup/scheduler operations run against that
  folder. Super-admin with no `activeTenant` is sent to the account list.
- **Webhook requests** (`/webhook/lead`, `/webhook/optout`): resolved by the
  **`?key=` (or `X-Bridge-Key`)** value → the account whose `config.webhookKey`
  matches → that tenant. A small key→tenant index is built from all tenant configs
  at boot and refreshed on config save. Webhook keys are **globally unique**
  (enforced on save; collision is rejected). This is what lets Anthony's existing
  GHL workflows keep working unchanged — his current key maps to "valor".

## 6. Refactor plan (the core work)

The current `store.js`, `verify.js`, `backup.js`, `scheduler.js` compute file paths
from a module-level `DATA_DIR` **singleton** (`CONFIG_PATH`, `REGISTRY_PATH`,
`BACKUP_DIR`, `STATE_PATH`). Multi-tenancy requires these to be resolved **per
tenant, per request**.

Approach: introduce a **`tenant.js`** module exposing `tenantPaths(tenantId)` →
`{ dir, configPath, logPath, registryPath, schedulerPath, backupDir }`, plus
account CRUD (`loadAccounts`, `saveAccounts`, `createAccount`, `verifyLogin`,
resolve-by-webhook-key). Thread a `paths` (or `tenantId`) argument through the
store/verify/backup functions instead of the module-level constants. Functions stay
pure with respect to the tenant directory, which also makes isolation testable.

`server.js` gains: session middleware (resolve account + activeTenant), a login
page + auth routes, super-admin `/admin/*` routes, and passes the resolved tenant
into every handler. Existing handlers change from "load the one config" to "load
*this tenant's* config".

## 7. Super-admin surface (`/admin`, super-role only)

- List accounts (label, id, disabled, created).
- Create account (label + id + initial password → seeds `data/tenants/<id>/` with
  an empty default config + fresh signing secret).
- Disable / enable an account (a disabled account can't log in and its webhook key
  stops routing).
- Reset an account's password.
- Open an account (§3.4).

## 8. Security / isolation

- Passwords scrypt-hashed; never returned by any endpoint.
- Session cookie HTTP-only + signed; tampering invalidates it.
- A tenant's requests can **only** read/write its own folder — enforced because the
  tenant id comes from the signed session, never from user input on `/api/*`.
- GHL tokens stay redacted in API responses (existing `redactConfig`).
- Webhook auth unchanged in spirit (shared key), now also the tenant selector.
- Super-admin "open" is the only cross-tenant path and is role-gated.

## 9. Migration & backward-compatibility (zero disruption)

On first boot of the new version, a one-time migration:
1. If `<DATA_DIR>/config.json` exists (legacy single-tenant) and
   `<DATA_DIR>/tenants/` does not → move `config.json`, `registry.json`,
   `activity.jsonl`, `scheduler.json`, `backups/` into `tenants/valor/`.
2. Create `accounts.json` with: a **super-admin** account (Anthony — seeded
   username/password, changeable), and a **"valor"** user account whose password
   is the current admin password (`adminPassword` from the migrated config, or a
   seed). Valor's `webhookKey` is preserved as-is.
3. Idempotent — safe to run on every boot; does nothing once migrated.

Result: Anthony's live brokers, registry, 178+ leads, and **existing webhook URL +
key all keep working** — his GHL workflows need no changes. Render env
(`DATA_DIR=/var/data`, disk, health check) is unchanged.

## 10. Testing

- **Isolation:** account A cannot read/write account B's config, registry, tokens,
  or activity.
- **Webhook routing:** a given key routes only to its owning tenant; a disabled
  account's key stops routing; duplicate-key save is rejected.
- **Auth:** login success/failure, scrypt verify, signed-cookie tamper rejection,
  logout, super-admin role gating on `/admin/*`.
- **Super-admin open:** can open any tenant and act within it; a user account
  cannot reach `/admin/*` or another tenant.
- **Migration:** legacy layout → `tenants/valor/` with data intact and webhook key
  preserved; idempotent on re-run.
- The existing **120 smoke checks** re-scoped to run against a tenant folder.

## 11. Rollout

Build + test locally under `MOCK=1`. Deploy to Anthony's Render. Migration runs on
boot. Verify: Valor's config/brokers/registry intact, webhook still bridges a test
lead, super-admin can log in and open Valor. Then Anthony creates the first
additional account and confirms isolation. Only then invite other teams/vendors.

## 12. Out of scope (YAGNI for v1)

- **Individual named users per team** — one shared login per account for now.
- **Agency-wide aggregate dashboard** — super-admin sees per-account; a cross-
  account roll-up is deferred.
- **Billing / per-account limits** — Anthony explicitly wants no limits.
- **Self-signup / email verification / self-service password reset** — accounts are
  admin-provisioned; super-admin resets passwords manually.
- **Per-vendor white-labeling** beyond the existing CastigliaAI branding.

## 13. Open questions

None blocking. Super-admin's seed username/password and the exact login-page look
are implementation details settled during the build.
