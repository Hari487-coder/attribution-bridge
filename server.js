/**
 * Attribution Bridge — replaces GHL "Copy Contact" with API-channel creates so
 * broker-side contacts carry createdBy.source = "INTEGRATION" and pass
 * CastigliaAI's DNC attribution check. Also: dry-run gate simulator + backlog
 * migration. See README.md.
 *
 * Run:  node server.js            (live)
 *       MOCK=1 node server.js     (no GHL credentials needed — fixtures)
 */

const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

const ghl = require("./lib/ghl");
const compliance = require("./lib/compliance");
const bridge = require("./lib/bridge");
const store = require("./lib/store");
const verify = require("./lib/verify");
const backup = require("./lib/backup");
const stats = require("./lib/stats");
const scheduler = require("./lib/scheduler");
const tenant = require("./lib/tenant");
const fs = require("node:fs");

const app = express();
// Only the restore endpoint accepts a large body (a full backup bundle). Every
// other route — including the pre-auth webhooks — gets a tight limit so an
// unauthenticated caller can't make the server buffer/parse a big payload.
// Capture the raw body so a webhook HMAC can be verified over the exact bytes.
const keepRaw = (req, _res, buf) => { req.rawBody = buf; };
const jsonSmall = express.json({ limit: "1mb", verify: keepRaw });
const jsonLarge = express.json({ limit: "8mb", verify: keepRaw });
app.use((req, res, next) => (req.path === "/api/restore" ? jsonLarge : jsonSmall)(req, res, next));

/** Merge settings, preserving the webhook signing secret across a redacted round-trip. */
function mergeSettings(current, incoming) {
  const merged = { ...current, ...(incoming ?? {}) };
  const inSecret = incoming?.webhookSigningSecret;
  if (inSecret === "(set)" || inSecret == null) merged.webhookSigningSecret = current?.webhookSigningSecret ?? "";
  return merged;
}

/**
 * Verify an optional HMAC-signed webhook. Returns { ok } or { ok:false, error }.
 * Signature = hex HMAC-SHA256 of `${timestamp}.${rawBody}` under the tenant's
 * webhookSigningSecret; the timestamp (ms epoch) must be within 5 minutes to
 * block replay. GHL's native webhook can't sign, so this is opt-in per tenant.
 */
function verifyWebhookSignature(secret, timestamp, signature, rawBody) {
  if (!timestamp || !signature) return { ok: false, error: "missing X-Bridge-Timestamp/X-Bridge-Signature" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return { ok: false, error: "timestamp missing, invalid, or outside the 5-minute window (replay?)" };
  }
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody ? rawBody.toString() : ""}`).digest("hex");
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "bad signature" };
  return { ok: true };
}

const BOOT_AT = new Date().toISOString();
const PORT = Number(process.env.PORT || 3344);

// ── Public health check (BEFORE auth, so external monitors can probe) ─────────
// Tenant-agnostic — no per-account data or secrets, just disk + account count.
app.get("/healthz", (_req, res) => {
  let diskWritable = false;
  try {
    const probe = path.join(store.DATA_DIR, ".healthz-probe");
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    diskWritable = true;
  } catch {
    diskWritable = false;
  }
  let accounts = 0;
  try {
    accounts = tenant.listAccounts().length;
  } catch {
    accounts = 0;
  }
  const ok = diskWritable; // the one thing that must be true for the pipeline to work
  res.status(ok ? 200 : 503).json({
    ok,
    mock: ghl.isMock(),
    diskWritable,
    accounts,
    bootAt: BOOT_AT,
  });
});

// ── Auth: login sessions + per-tenant request context ─────────────────────────
//
// Accounts live in accounts.json (super-admin + one "user" account per tenant).
// A successful login sets an HMAC-signed `ab_session` cookie. Dashboard/API
// requests run inside the active tenant's data context (AsyncLocalStorage), so
// every store/verify/backup call transparently reads that tenant's files.
// Webhooks carry no cookie — they resolve their tenant from the webhook key.

const SESSION_COOKIE = "ab_session";
const SESSION_MAX_AGE_S = 14 * 24 * 3600;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, payload) {
  const token = tenant.signSession(payload);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Resolve the live session from the cookie. Returns
 *   { accountId, role, activeTenant, account }  or  null.
 * A user account is locked to its own tenant; only a super-admin can carry an
 * activeTenant chosen at "open" time (null = still at the account picker).
 */
function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const payload = token ? tenant.verifySession(token) : null;
  if (!payload) return null;
  const acct = tenant.getAccount(payload.accountId);
  if (!acct || acct.disabled) return null;
  const activeTenant = acct.role === "super" ? payload.activeTenant ?? null : acct.tenantId;
  return { accountId: acct.id, role: acct.role, activeTenant, account: acct };
}

function authState(req) {
  req.session = readSession(req);
  return req.session;
}

/** Require login; JSON 401 for API callers. */
function requireLoginJson(req, res, next) {
  if (!authState(req)) return res.status(401).json({ ok: false, error: "not logged in" });
  next();
}

/** Require login; redirect browsers to the login page. */
function requireLoginPage(req, res, next) {
  if (!authState(req)) return res.redirect("/login");
  next();
}

/** Super-admin only. */
function requireSuper(req, res, next) {
  if (req.session?.role !== "super") return res.status(403).json({ ok: false, error: "super-admin only" });
  next();
}

/** Run the rest of the request inside the active tenant's data context. */
function withTenant(req, res, next) {
  const tid = req.session?.activeTenant;
  if (!tid) return res.status(409).json({ ok: false, error: "no account selected" });
  tenant.runInTenant(tid, () => next());
}

/** Webhook: resolve the tenant from ?key= / X-Bridge-Key, then run inside it. */
function webhookTenant(req, res, next) {
  const key = req.query.key || req.headers["x-bridge-key"];
  const tid = key ? tenant.resolveTenantByWebhookKey(key) : null;
  if (!tid) return res.status(401).json({ ok: false, error: "bad or unknown webhook key" });
  tenant.runInTenant(tid, () => {
    // If this tenant enabled webhook signing, the shared key alone isn't enough:
    // require a fresh, valid HMAC signature (stronger auth + replay protection).
    const secret = store.loadConfig().settings?.webhookSigningSecret;
    if (secret) {
      const check = verifyWebhookSignature(secret, req.headers["x-bridge-timestamp"], req.headers["x-bridge-signature"], req.rawBody);
      if (!check.ok) return res.status(401).json({ ok: false, error: `signed webhook required: ${check.error}` });
    }
    next();
  });
}

// ── Webhook: master GHL workflow → distribute lead ──────────────────────────

/**
 * POST /webhook/lead?key=...
 * Body (from GHL workflow webhook / custom webhook action):
 *   { contact_id: "...", broker_key: "..." }
 * broker_key can also come from customData.broker_key (GHL nests custom fields
 * there in workflow webhooks) or a query param for per-broker webhook URLs.
 */
app.post("/webhook/lead", webhookTenant, async (req, res) => {
  const config = store.loadConfig();
  const body = req.body ?? {};
  const contactId =
    body.contact_id || body.contactId || body.customData?.contact_id || body.id || null;
  let brokerKey =
    req.query.broker ||
    body.broker_key ||
    body.brokerKey ||
    body.customData?.broker_key ||
    null;

  if (!contactId) {
    store.appendLog({ kind: "distribute", ok: false, error: "missing contact_id", receivedKeys: Object.keys(body) });
    return res.status(400).json({ ok: false, error: "Need contact_id (in body, customData, or as id)." });
  }

  let idemKey = null;
  try {
    // Auto-route by tag (SOP 3.3) when no explicit broker_key was sent: read the
    // master contact's tags and match them against the tag→broker map.
    let routed = null;
    if (!brokerKey) {
      if (!config.master?.token) {
        return res.status(422).json({ ok: false, error: "No broker_key sent and master token not configured for tag routing." });
      }
      const master = await ghl.getContact(contactId, config.master.token);
      routed = bridge.resolveBrokerByTags(master?.tags, config.settings);
      brokerKey = routed.brokerKey;
      if (!brokerKey) {
        // A routing miss is an intentional non-distribution (lead lacks the
        // trigger/broker tag), not a bridge failure — mark it skipped so it
        // doesn't inflate the error funnel or trigger a false failure alert.
        const info = { kind: "distribute", ok: false, skipped: true, contactId, routed: true, reason: routed.reason, tags: master?.tags ?? [] };
        store.appendLog(info);
        return res.status(422).json({ ok: false, routed: true, error: `Could not route contact: ${routed.reason}.` });
      }
    }

    // Replay protection: a duplicate delivery (GHL retry, or a replayed request)
    // for the same contact→broker within the window is a no-op, so it can't create
    // a duplicate or churn a "recreate"-policy contact. An explicit event id in the
    // body tightens the key when the caller supplies one.
    const eventId = body.event_id || body.eventId || body.idempotency_key || "";
    idemKey = `${contactId}:${brokerKey}:${eventId}`;
    if (!store.claimIdempotency(idemKey)) {
      store.appendLog({ kind: "distribute", ok: true, idempotent: true, contactId, brokerKey });
      return res.status(200).json({ ok: true, idempotent: true, note: "duplicate webhook ignored (already processed recently)" });
    }

    const result = await bridge.distributeLead({ contactId, brokerKey }, config);
    // Idempotency remembers OUTCOMES, not attempts: keep the key on success or a
    // deterministic refusal (opt-out / no-attribution / suppressed — a retry would
    // just refuse again), but release it on a transient/config error so a genuine
    // retry can proceed instead of being silently swallowed for the TTL.
    if (result.ok === false && !result.refused) store.releaseIdempotency(idemKey);
    return res.status(result.ok ? 200 : 422).json({ ...result, routedBy: routed ? `tag:${routed.matchedTag}` : "explicit" });
  } catch (err) {
    if (idemKey) store.releaseIdempotency(idemKey); // transient throw — allow retry
    store.appendLog({ kind: "distribute", ok: false, brokerKey, contactId, error: err.message });
    return res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * POST /webhook/optout?key=...  — opt-out feed for a GHL workflow.
 * Body: { phone } or { contact_id } (looked up in the master location).
 * A withdrawal always wins: the number is refused for future bridges.
 */
app.post("/webhook/optout", webhookTenant, async (req, res) => {
  const config = store.loadConfig();
  const body = req.body ?? {};
  let phone = body.phone || body.customData?.phone || null;
  const contactId = body.contact_id || body.contactId || body.customData?.contact_id || null;
  try {
    if (!phone && contactId && config.master.token) {
      const c = await ghl.getContact(contactId, config.master.token);
      phone = c?.phone ?? null;
    }
    if (!phone) {
      return res.status(400).json({ ok: false, error: "need phone or resolvable contact_id" });
    }
    if (!verify.isPlausiblePhone(phone)) {
      return res.status(400).json({ ok: false, error: `not a valid phone number: ${JSON.stringify(phone)}` });
    }
    const record = verify.withdrawVerification(phone, body.reason || "opt-out webhook");
    // Opt-out also suppresses copies already sitting in broker subaccounts (set
    // DND) so the dialer stops immediately, not just on future bridges.
    const suppressed = await bridge.suppressAcrossBrokers(record.phone, config).catch((e) => ({ error: e.message }));
    store.appendLog({ kind: "optout-suppress", phone: record.phone, suppressed });
    return res.json({ ok: true, record, suppressed });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ── Dashboard API ────────────────────────────────────────────────────────────

// Auth + tenant context are applied at the mount (app.use("/api", ...)) so every
// route below runs logged-in and inside the active tenant's data folder.
const api = express.Router();

api.get("/config", (_req, res) => {
  res.json({ ok: true, config: store.redactConfig(store.loadConfig()), mock: ghl.isMock() });
});

api.post("/config", (req, res) => {
  const current = store.loadConfig();
  const incoming = req.body ?? {};
  const keepToken = (newTok, oldTok) =>
    newTok && !String(newTok).startsWith("…") ? newTok : oldTok;

  const { adminPassword, ...currentSansPassword } = current; // drop the legacy field
  const next = {
    ...currentSansPassword,
    webhookKey: incoming.webhookKey ?? current.webhookKey,
    // Never overwrite the signing secret from a redacted round-trip.
    signingSecret: current.signingSecret,
    // adminPassword is no longer used — auth is per-account (see accounts.json).
    // Omitting it here purges the legacy plaintext field on the next save.
    master: {
      label: incoming.master?.label ?? current.master.label,
      locationId: incoming.master?.locationId ?? current.master.locationId,
      token: keepToken(incoming.master?.token, current.master.token),
    },
    settings: mergeSettings(current.settings, incoming.settings),
    brokers: current.brokers,
  };

  // The webhook key is how GHL workflows address THIS tenant's bridge. It must be
  // unique across every account, or a lead would route to the wrong instance.
  if (next.webhookKey && tenant.webhookKeyTaken(next.webhookKey, req.session.activeTenant)) {
    return res.status(409).json({
      ok: false,
      error: "That webhook key is already in use by another account. Pick a different one.",
    });
  }

  if (incoming.brokers) {
    const merged = {};
    for (const [key, b] of Object.entries(incoming.brokers)) {
      const old = current.brokers[key] ?? {};
      const token = keepToken(b.token, old.token);
      // A masked token on a key with no stored token (new or renamed broker)
      // would persist an empty token and silently break that broker's calls.
      if (b.token && String(b.token).startsWith("…") && !old.token) {
        return res.status(400).json({
          ok: false,
          error: `Token required for new or renamed broker "${key}" — the masked value has no stored token behind it. Paste the real API token.`,
        });
      }
      merged[key] = {
        label: b.label ?? old.label ?? key,
        locationId: b.locationId ?? old.locationId ?? "",
        token,
      };
    }
    next.brokers = merged;
  }

  store.saveConfig(next);
  // Snapshot on every successful config change so an accidental clobber is undoable.
  backup.writeSnapshot("config-save");
  res.json({ ok: true, config: store.redactConfig(next) });
});

api.get("/log", (req, res) => {
  res.json({ ok: true, entries: store.readLog({ limit: Number(req.query.limit) || 200 }) });
});

// ── Ops: metrics, backup/restore, alerts (Tier 1) ────────────────────────────

api.get("/stats", (req, res) => {
  const sinceIso = req.query.since || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  res.json({ ok: true, ...stats.summarize({ sinceIso }) });
});

// Download a full backup bundle (contains live tokens — admin-authed only).
api.get("/backup", (_req, res) => {
  const bundle = backup.buildBundle();
  const stamp = bundle.at.replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="attribution-bridge-backup-${stamp}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

api.post("/backup/now", async (_req, res) => {
  const snap = backup.writeSnapshot("manual");
  const cfg = store.loadConfig();
  let offbox = { ok: false, error: "no backupWebhookUrl configured" };
  if (cfg.settings?.backupWebhookUrl) offbox = await backup.pushOffbox(cfg.settings.backupWebhookUrl);
  res.json({ ok: true, snapshot: snap, offbox, snapshots: backup.listSnapshots().length });
});

api.post("/restore", (req, res) => {
  const r = backup.restoreBundle(req.body);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, restoredFrom: r.at, brokers: r.brokers, note: "config + registry restored; a pre-restore snapshot was saved." });
});

api.post("/alert/test", async (_req, res) => {
  const cfg = store.loadConfig();
  const url = cfg.settings?.alertWebhookUrl;
  if (!url) return res.status(400).json({ ok: false, error: "Set an alert webhook URL in Setup first." });
  try {
    await scheduler.sendDigest(url);
    res.json({ ok: true, sentTo: url });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/precheck — "would CastigliaAI block this call?"
 * Body: { phone } for number-only, or { brokerKey|"master", contactId } for the
 * full contact-aware simulation (DND + attribution + national DNC).
 */
api.post("/precheck", async (req, res) => {
  const { phone, brokerKey, contactId } = req.body ?? {};
  const config = store.loadConfig();
  try {
    let contact = null;
    let usedPhone = phone;
    if (contactId) {
      const loc = brokerKey === "master" || !brokerKey ? config.master : config.brokers[brokerKey];
      if (!loc?.token) {
        return res
          .status(400)
          .json({ ok: false, error: `No token configured for "${brokerKey || "master"}".` });
      }
      contact = await ghl.getContact(contactId, loc.token);
      usedPhone = usedPhone || contact.phone;
    }
    if (!usedPhone) {
      return res.status(400).json({ ok: false, error: "Provide a phone or a contactId." });
    }
    const sim = await compliance.simulateGate(contact, usedPhone);
    const evidenceDetail = contact
      ? {
          attributionSource: compliance.hasPopulatedValues(contact.attributionSource),
          lastAttributionSource: compliance.hasPopulatedValues(contact.lastAttributionSource),
          createdBySource: contact.createdBy?.source ?? null,
        }
      : null;
    const registered = verify.isVerified(sim.normalized);
    const withdrawn = !registered && verify.listVerifications().find(
      (r) => r.phone === sim.normalized && r.status === "withdrawn"
    );
    const registryStatus = registered
      ? { status: "verified", evidence: registered.evidence, verifiedAt: registered.verifiedAt }
      : withdrawn
        ? { status: "withdrawn", withdrawnAt: withdrawn.withdrawnAt, reason: withdrawn.withdrawnReason }
        : { status: "none" };
    store.appendLog({
      kind: "precheck",
      phone: sim.normalized,
      contactId: contactId ?? null,
      wouldBlock: sim.wouldBlock,
      reason: sim.reason,
    });
    res.json({ ok: true, contactChecked: !!contact, evidenceDetail, registryStatus, ...sim });
  } catch (err) {
    // 200 (not 5xx): upstream/GHL errors carry a useful message in the body, and
    // proxies (Cloudflare, Render) replace any 5xx body with their own HTML page,
    // which would hide it. The dashboard checks the `ok` field, not the status.
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── Verification registry ────────────────────────────────────────────────────

api.get("/verify/list", (_req, res) => {
  res.json({ ok: true, entries: verify.listVerifications() });
});

/** Manually verify a MASTER contact and register it (verifies opt-in first). */
api.post("/verify/register", async (req, res) => {
  const { contactId } = req.body ?? {};
  const config = store.loadConfig();
  if (!contactId) return res.status(400).json({ ok: false, error: "contactId required" });
  if (!config.master.token) return res.status(400).json({ ok: false, error: "master token not configured" });
  try {
    const master = await ghl.getContact(contactId, config.master.token);
    const a = verify.assessMaster(master);
    if (!a.verified) return res.status(422).json({ ok: false, refused: true, reason: a.reason });
    const record = verify.registerVerification({
      phone: a.phone,
      evidence: a.evidence,
      masterContactId: contactId,
      workspaceLabel: config.master.label,
    });
    res.json({ ok: true, record });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

/** Withdraw (opt-out) a number — always wins over any verification. */
api.post("/verify/withdraw", async (req, res) => {
  const { phone, reason } = req.body ?? {};
  if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
  if (!verify.isPlausiblePhone(phone)) {
    return res.status(400).json({ ok: false, error: `not a valid phone number: ${JSON.stringify(phone)}` });
  }
  const record = verify.withdrawVerification(phone, reason ?? "manual");
  // Also suppress any already-bridged broker copies (set DND) so the opt-out
  // reaches contacts created before the withdrawal, not just future bridges.
  const suppressed = await bridge.suppressAcrossBrokers(record.phone, store.loadConfig()).catch((e) => ({ error: e.message }));
  store.appendLog({ kind: "optout-suppress", phone: record.phone, suppressed });
  res.json({ ok: true, record, suppressed });
});

// The verifiable consent record for a number. This is what Assistable's backend
// (or a compliance auditor) reads to confirm a bridged lead's opt-in: it carries
// the actual attribution values + a pointer to the master record. Set recheck=1
// to ALSO re-assess the live master (the authoritative, unforgeable check).
api.get("/verify/consent", async (req, res) => {
  const phone = req.query.phone;
  if (!phone || !verify.isPlausiblePhone(phone)) {
    return res.status(400).json({ ok: false, error: "valid ?phone= required" });
  }
  const record = verify.consentEvidenceFor(phone);
  if (!record) return res.status(404).json({ ok: false, error: "no active consent record for that number" });
  const out = { ok: true, record, signatureValid: verify.verifyConsent(record) };
  if (req.query.recheck && record.master?.contactId) {
    // Re-verify against the live master — the check that needs no trust in the
    // bridge. Anyone with read access to the master can reproduce this.
    try {
      const cfg = store.loadConfig();
      const master = await ghl.getContact(record.master.contactId, cfg.master.token);
      const a = verify.assessMaster(master);
      out.liveRecheck = { verified: a.verified, evidence: a.evidence ?? null, reason: a.verified ? null : a.reason };
    } catch (e) {
      out.liveRecheck = { error: e.message };
    }
  }
  res.json(out);
});

api.post("/test-channel", async (req, res) => {
  try {
    const result = await bridge.testChannel(req.body?.brokerKey, store.loadConfig());
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

api.post("/distribute", async (req, res) => {
  const { contactId, brokerKey } = req.body ?? {};
  if (!contactId || !brokerKey) {
    return res.status(400).json({ ok: false, error: "contactId and brokerKey required" });
  }
  try {
    const result = await bridge.distributeLead({ contactId, brokerKey }, store.loadConfig());
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

api.post("/migrate/scan", async (req, res) => {
  try {
    const b = req.body ?? {};
    const result = await bridge.migrateScan(b.brokerKey, store.loadConfig(), {
      startAfterId: b.startAfterId,
      startAfter: b.startAfter,
      pages: Number(b.pages) || 3,
      includeTags: Array.isArray(b.includeTags) ? b.includeTags : [],
      excludeTags: Array.isArray(b.excludeTags) ? b.excludeTags : [],
      includeMode: b.includeMode === "all" ? "all" : "any",
      masterIncludeTags: Array.isArray(b.masterIncludeTags) ? b.masterIncludeTags : [],
      masterExcludeTags: Array.isArray(b.masterExcludeTags) ? b.masterExcludeTags : [],
      masterIncludeMode: b.masterIncludeMode === "all" ? "all" : "any",
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

api.post("/migrate/run", async (req, res) => {
  const { brokerKey, contactIds, dryRun, overrideTags } = req.body ?? {};
  if (!brokerKey || !Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ ok: false, error: "brokerKey and contactIds[] required" });
  }
  try {
    const result = await bridge.migrateRun(brokerKey, contactIds, store.loadConfig(), {
      dryRun: dryRun !== false, // dry-run unless explicitly disabled
      // Only override when a non-empty list is supplied; blank = default behavior.
      overrideTags: Array.isArray(overrideTags) && overrideTags.length ? overrideTags : null,
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── Master → broker bulk import ──────────────────────────────────────────────

api.post("/master/scan", async (req, res) => {
  try {
    const b = req.body ?? {};
    const result = await bridge.masterScan(store.loadConfig(), {
      startAfterId: b.startAfterId,
      startAfter: b.startAfter,
      pages: Number(b.pages) || 3,
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

api.post("/master/push", async (req, res) => {
  const { brokerKey, contactIds, dryRun } = req.body ?? {};
  if (!brokerKey || !Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ ok: false, error: "brokerKey and contactIds[] required" });
  }
  try {
    const result = await bridge.masterPush(brokerKey, contactIds, store.loadConfig(), {
      dryRun: dryRun !== false, // dry-run unless explicitly disabled
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── One-time (ad-hoc) transfer between arbitrary source→destination accounts ──
// Credentials are provided inline and are NEVER saved to config. Same guarantees:
// the mandatory opt-in gate, opt-out registry, and INTEGRATION stamp all apply.
// Reuses masterScan/masterPush with a transient in-memory config.
function adhocConfig({ srcLoc, srcTok, dstLoc, dstTok, duplicatePolicy } = {}) {
  const base = store.loadConfig().settings;
  return {
    master: { locationId: srcLoc, token: srcTok, label: "source" },
    brokers: dstLoc ? { adhoc: { locationId: dstLoc, token: dstTok, label: "destination" } } : {},
    settings: {
      ...base,
      // Neutral for an arbitrary account: copy all source tags, no campaign
      // force-adds; the operator picks the duplicate policy per transfer.
      tagCopyMode: "all",
      alwaysAddTags: [],
      duplicatePolicy: ["skip", "strip", "recreate"].includes(duplicatePolicy) ? duplicatePolicy : "skip",
    },
  };
}

api.post("/adhoc/scan", async (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.sourceLocationId || !b.sourceToken) {
      return res.status(400).json({ ok: false, error: "Source location ID and API token are required." });
    }
    const cfg = adhocConfig({ srcLoc: b.sourceLocationId, srcTok: b.sourceToken });
    const result = await bridge.masterScan(cfg, {
      startAfterId: b.startAfterId,
      startAfter: b.startAfter,
      pages: Number(b.pages) || 3,
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

api.post("/adhoc/push", async (req, res) => {
  const b = req.body ?? {};
  if (!b.sourceLocationId || !b.sourceToken || !b.destLocationId || !b.destToken) {
    return res.status(400).json({ ok: false, error: "Source and destination location IDs and tokens are all required." });
  }
  if (!Array.isArray(b.contactIds) || b.contactIds.length === 0) {
    return res.status(400).json({ ok: false, error: "Select at least one contact." });
  }
  try {
    const cfg = adhocConfig({
      srcLoc: b.sourceLocationId,
      srcTok: b.sourceToken,
      dstLoc: b.destLocationId,
      dstTok: b.destToken,
      duplicatePolicy: b.duplicatePolicy,
    });
    const result = await bridge.masterPush("adhoc", b.contactIds, cfg, { dryRun: b.dryRun !== false });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── Login / session ──────────────────────────────────────────────────────────

const PUBLIC = path.join(__dirname, "public");
const redactAcct = (a) => {
  if (!a) return null;
  const { passwordHash, passwordSalt, ...rest } = a;
  return rest;
};

app.get("/login", (req, res) => {
  if (authState(req)) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "login.html"));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body ?? {};
  const acct = tenant.verifyLogin(username, password);
  if (!acct) return res.status(401).json({ ok: false, error: "Invalid username or password." });
  // A super-admin lands on the account picker (no active tenant); a normal user
  // goes straight into their own instance.
  const activeTenant = acct.role === "super" ? null : acct.tenantId;
  setSessionCookie(res, { accountId: acct.id, activeTenant });
  res.json({ ok: true, role: acct.role, needsPicker: acct.role === "super" });
});

app.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Who am I? (any logged-in account) — powers the header banner + account switch.
app.get("/api/me", requireLoginJson, (req, res) => {
  const s = req.session;
  const activeAcct = s.activeTenant ? tenant.getAccount(s.activeTenant) : null;
  res.json({
    ok: true,
    account: { id: s.accountId, username: s.account.username, label: s.account.label, role: s.role },
    isSuper: s.role === "super",
    activeTenant: s.activeTenant,
    activeTenantLabel: activeAcct?.label ?? null,
  });
});

// ── Super-admin: account management ───────────────────────────────────────────

const adminApi = express.Router();
adminApi.use(requireLoginJson, requireSuper);

adminApi.get("/accounts", (_req, res) => {
  res.json({ ok: true, accounts: tenant.listAccounts() });
});

adminApi.post("/accounts", (req, res) => {
  try {
    const { username, label, password, role } = req.body ?? {};
    const acct = tenant.createAccount({ username, label, password, role: role === "super" ? "super" : "user" });
    res.json({ ok: true, account: redactAcct(acct) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/accounts/:id/disable", (req, res) => {
  try {
    tenant.setDisabled(req.params.id, !!req.body?.disabled);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/accounts/:id/password", (req, res) => {
  try {
    if (!req.body?.password) throw new Error("password required");
    tenant.setPassword(req.params.id, req.body.password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// "Open" a tenant: a super-admin re-signs their cookie with the chosen tenant so
// every following dashboard/API call runs inside that instance. tenantId=null
// returns them to the account picker.
adminApi.post("/open", (req, res) => {
  const tid = req.body?.tenantId || null;
  if (tid) {
    const acct = tenant.getAccount(tid);
    if (!acct || acct.role === "super" || !acct.tenantId) {
      return res.status(404).json({ ok: false, error: "no such account" });
    }
  }
  setSessionCookie(res, { accountId: req.session.accountId, activeTenant: tid });
  res.json({ ok: true, activeTenant: tid });
});

app.use("/admin/api", adminApi);

// ── Dashboard API + UI (login required, scoped to the active tenant) ──────────

app.use("/api", requireLoginJson, withTenant, api);

app.get("/", requireLoginPage, (req, res) => {
  // Super-admin with no instance selected → the account picker.
  if (req.session.role === "super" && !req.session.activeTenant) {
    return res.sendFile(path.join(PUBLIC, "admin.html"));
  }
  res.sendFile(path.join(PUBLIC, "index.html"));
});

app.use("/", requireLoginPage, express.static(PUBLIC));

app.listen(PORT, () => {
  tenant.migrateLegacyIfNeeded(); // legacy single-tenant → tenants/valor + seed super-admin
  if (!ghl.isMock()) scheduler.start(); // digest/alerts/backup — skip in mock/tests
  const mode = ghl.isMock() ? "MOCK (no GHL calls)" : "LIVE";
  console.log(`attribution-bridge listening on http://localhost:${PORT} [${mode}]`);
});
