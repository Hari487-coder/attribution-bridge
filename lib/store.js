/**
 * store.js — zero-dependency persistence: JSON config file + JSONL activity log.
 * Volume is tiny (config edits + one log line per lead), so file I/O is fine.
 */

const fs = require("node:fs");
const path = require("node:path");

// DATA_DIR env overrides the default so cloud hosts can point at a persistent
// disk (e.g. Render mounts one at /var/data). Default: <app>/data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LOG_PATH = path.join(DATA_DIR, "activity.jsonl");

const DEFAULT_CONFIG = {
  // Shared secret the master GHL workflow must send (query ?key= or X-Bridge-Key header)
  webhookKey: "",
  // Dashboard password (Basic auth, user "admin"). Empty = no auth (local use only).
  adminPassword: "",
  // HMAC secret for verification-registry signatures. Auto-generated on first use.
  signingSecret: "",
  master: { locationId: "", token: "", label: "Master" },
  // brokers: key → { label, locationId, token }
  brokers: {},
  settings: {
    // What to do when the broker already has a contact with this phone:
    //   "skip"     — log and leave the old copy (nothing created)
    //   "strip"    — Option A: strip phone/email off the old copy (keep it +
    //                its conversation history), then create the new one
    //   "recreate" — Option B: delete the old copy, then create the new one
    duplicatePolicy: "skip",
    // Copy custom fields by fieldKey match between locations
    copyCustomFields: true,
    // Extra tag stamped on every bridged contact for visibility in GHL
    bridgeTag: "attribution-bridge",
    // Tag + audit-note label written on verified contacts (white-labelable).
    verifiedTag: "castigliaai-verified",
    verifiedNoteLabel: "CastigliaAI-Verified",
    // NOTE: the opt-in/attribution gate is MANDATORY and enforced unconditionally
    // in bridge.js — a lead whose master record shows no genuine opt-in evidence is
    // NEVER created in a broker. There is deliberately no setting to disable it. A
    // legacy `requireMasterEvidence` value may linger in older config files; it is
    // ignored.
    // Country calling code (digits, no +) used to canonicalize registry keys so a
    // national-format opt-out matches an E.164 record. "1" = US/Canada (NANP).
    defaultCallingCode: "1",
    // Auto-routing (SOP 3.3): map a master/Meta tag → broker key. When the
    // webhook fires without an explicit broker_key, the contact's tags are
    // matched against this map to pick the destination broker.
    tagRouting: {},
    // Distribution trigger tag (SOP 3.3.1): a lead must carry this tag to be
    // eligible for auto-routing. "adl" mirrors the existing GHL drip trigger.
    distributionTag: "adl",
    // Ops (Tier 1): outbound webhook URLs the operator owns (e.g. a GHL inbound
    // webhook → email/SMS) for failure alerts + the daily digest heartbeat, and
    // a separate URL to receive the nightly off-box backup bundle. Empty = off.
    alertWebhookUrl: "",
    backupWebhookUrl: "",
    // Hour of day (UTC) to send the daily digest + take the daily backup.
    digestHourUtc: 13,
  },
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      master: { ...DEFAULT_CONFIG.master, ...(raw.master ?? {}) },
      brokers: raw.brokers ?? {},
      settings: { ...DEFAULT_CONFIG.settings, ...(raw.settings ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(config) {
  ensureDataDir();
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function appendLog(entry) {
  ensureDataDir();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function readLog({ limit = 200 } = {}) {
  try {
    const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Redact tokens for API responses. */
function redactConfig(config) {
  const mask = (t) => (t ? `…${String(t).slice(-4)}` : "");
  return {
    ...config,
    adminPassword: config.adminPassword ? "(set)" : "",
    signingSecret: config.signingSecret ? "(set)" : "",
    master: { ...config.master, token: mask(config.master.token), tokenSet: !!config.master.token },
    brokers: Object.fromEntries(
      Object.entries(config.brokers).map(([k, b]) => [
        k,
        { ...b, token: mask(b.token), tokenSet: !!b.token },
      ])
    ),
  };
}

module.exports = { loadConfig, saveConfig, appendLog, readLog, redactConfig, CONFIG_PATH, LOG_PATH, DATA_DIR };
