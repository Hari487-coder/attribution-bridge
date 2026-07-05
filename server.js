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
const fs = require("node:fs");

const app = express();
// Only the restore endpoint accepts a large body (a full backup bundle). Every
// other route — including the pre-auth webhooks — gets a tight limit so an
// unauthenticated caller can't make the server buffer/parse a big payload.
const jsonSmall = express.json({ limit: "1mb" });
const jsonLarge = express.json({ limit: "8mb" });
app.use((req, res, next) => (req.path === "/api/restore" ? jsonLarge : jsonSmall)(req, res, next));

const BOOT_AT = new Date().toISOString();
const PORT = Number(process.env.PORT || 3344);

// ── Public health check (BEFORE auth, so external monitors can probe) ─────────
// No secrets — booleans and counts only.
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
  let cfg = {};
  try {
    cfg = store.loadConfig();
  } catch {
    cfg = {};
  }
  const configured = !!(cfg.master?.token && Object.keys(cfg.brokers || {}).length);
  const ok = diskWritable; // the one thing that must be true for the pipeline to work
  res.status(ok ? 200 : 503).json({
    ok,
    mock: ghl.isMock(),
    diskWritable,
    configured,
    brokerCount: Object.keys(cfg.brokers || {}).length,
    lastActivityAt: stats.lastActivityAt(), // tail-read only — never parses the whole log
    bootAt: BOOT_AT,
  });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Dashboard/API auth: Basic (admin / config.adminPassword). No password = open (local use). */
function dashboardAuth(req, res, next) {
  const config = store.loadConfig();
  if (!config.adminPassword) return next();
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (user === "admin" && timingSafeEqual(pass ?? "", config.adminPassword)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="attribution-bridge"');
  return res.status(401).send("Auth required");
}

/** Webhook auth: shared key via ?key= or X-Bridge-Key header. */
function webhookAuth(req, res, next) {
  const config = store.loadConfig();
  if (!config.webhookKey) {
    return res
      .status(403)
      .json({ ok: false, error: "webhookKey not configured — set it in Setup before wiring GHL." });
  }
  const supplied = req.query.key || req.headers["x-bridge-key"];
  if (supplied && timingSafeEqual(supplied, config.webhookKey)) return next();
  return res.status(401).json({ ok: false, error: "bad webhook key" });
}

// ── Webhook: master GHL workflow → distribute lead ──────────────────────────

/**
 * POST /webhook/lead?key=...
 * Body (from GHL workflow webhook / custom webhook action):
 *   { contact_id: "...", broker_key: "..." }
 * broker_key can also come from customData.broker_key (GHL nests custom fields
 * there in workflow webhooks) or a query param for per-broker webhook URLs.
 */
app.post("/webhook/lead", webhookAuth, async (req, res) => {
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

    const result = await bridge.distributeLead({ contactId, brokerKey }, config);
    return res.status(result.ok ? 200 : 422).json({ ...result, routedBy: routed ? `tag:${routed.matchedTag}` : "explicit" });
  } catch (err) {
    store.appendLog({ kind: "distribute", ok: false, brokerKey, contactId, error: err.message });
    return res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * POST /webhook/optout?key=...  — opt-out feed for a GHL workflow.
 * Body: { phone } or { contact_id } (looked up in the master location).
 * A withdrawal always wins: the number is refused for future bridges.
 */
app.post("/webhook/optout", webhookAuth, async (req, res) => {
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
    return res.json({ ok: true, record });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ── Dashboard API ────────────────────────────────────────────────────────────

const api = express.Router();
api.use(dashboardAuth);

api.get("/config", (_req, res) => {
  res.json({ ok: true, config: store.redactConfig(store.loadConfig()), mock: ghl.isMock() });
});

api.post("/config", (req, res) => {
  const current = store.loadConfig();
  const incoming = req.body ?? {};
  const keepToken = (newTok, oldTok) =>
    newTok && !String(newTok).startsWith("…") ? newTok : oldTok;

  const next = {
    ...current,
    webhookKey: incoming.webhookKey ?? current.webhookKey,
    // Never overwrite the signing secret from a redacted round-trip.
    signingSecret: current.signingSecret,
    adminPassword:
      incoming.adminPassword === "(set)" || incoming.adminPassword == null
        ? current.adminPassword
        : incoming.adminPassword,
    master: {
      label: incoming.master?.label ?? current.master.label,
      locationId: incoming.master?.locationId ?? current.master.locationId,
      token: keepToken(incoming.master?.token, current.master.token),
    },
    settings: { ...current.settings, ...(incoming.settings ?? {}) },
    brokers: current.brokers,
  };

  // A fresh public deployment must not hold API tokens behind an open dashboard:
  // refuse to store any token until a dashboard password exists.
  const willHavePassword = !!next.adminPassword;
  const savingAnyToken =
    (incoming.master?.token && !String(incoming.master.token).startsWith("…")) ||
    Object.values(incoming.brokers ?? {}).some(
      (b) => b?.token && !String(b.token).startsWith("…")
    );
  if (savingAnyToken && !willHavePassword) {
    return res.status(400).json({
      ok: false,
      error:
        "Set a dashboard password before saving API tokens — otherwise anyone with this URL could read your GHL credentials.",
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
api.post("/verify/withdraw", (req, res) => {
  const { phone, reason } = req.body ?? {};
  if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
  if (!verify.isPlausiblePhone(phone)) {
    return res.status(400).json({ ok: false, error: `not a valid phone number: ${JSON.stringify(phone)}` });
  }
  res.json({ ok: true, record: verify.withdrawVerification(phone, reason ?? "manual") });
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
    const result = await bridge.migrateScan(req.body?.brokerKey, store.loadConfig(), {
      maxPages: Number(req.body?.maxPages) || 10,
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

api.post("/migrate/run", async (req, res) => {
  const { brokerKey, contactIds, dryRun } = req.body ?? {};
  if (!brokerKey || !Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ ok: false, error: "brokerKey and contactIds[] required" });
  }
  try {
    const result = await bridge.migrateRun(brokerKey, contactIds, store.loadConfig(), {
      dryRun: dryRun !== false, // dry-run unless explicitly disabled
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

app.use("/api", api);

// ── UI ───────────────────────────────────────────────────────────────────────

app.use("/", dashboardAuth, express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  verify.ensureSigningSecret(); // generate the registry HMAC secret once
  if (!ghl.isMock()) scheduler.start(); // digest/alerts/backup — skip in mock/tests
  const mode = ghl.isMock() ? "MOCK (no GHL calls)" : "LIVE";
  console.log(`attribution-bridge listening on http://localhost:${PORT} [${mode}]`);
});
