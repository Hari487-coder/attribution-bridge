/**
 * store.js — zero-dependency persistence: JSON config file + JSONL activity log.
 * Volume is tiny (config edits + one log line per lead), so file I/O is fine.
 */

const fs = require("node:fs");
const path = require("node:path");
const tenant = require("./tenant");

// DATA_DIR is the root disk (Render mounts one at /var/data). Per-tenant files
// (config.json, activity.jsonl) live under it and are resolved per-request via
// tenant.configPath()/logPath(); outside a tenant context (tests/scripts) those
// fall back to DATA_DIR itself, so pre-multi-tenant callers keep working.
const DATA_DIR = tenant.DATA_DIR;

const DEFAULT_CONFIG = {
  // Shared secret the master GHL workflow must send (query ?key= or X-Bridge-Key
  // header). Routes the webhook to THIS account's instance — globally unique.
  webhookKey: "",
  // NOTE: dashboard auth is now per-account (login) — see lib/tenant.js +
  // accounts.json. Any legacy `adminPassword` in an older config file is unused
  // and purged on the next Setup save.
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
    // Which of the MASTER contact's tags to carry onto the broker contact so the
    // broker's tag-triggered workflows fire (e.g. "Veterans", "Valor Assurance"):
    //   "all"  — copy every tag on the master contact (default)
    //   "list" — copy ONLY the tags named in tagCopyList (that are on the master)
    //   "none" — copy no master tags (the app's own bridge/verified tags still apply)
    // The bridge reads tags from the master contact itself — GHL does not need to
    // send them in the webhook.
    tagCopyMode: "all",
    tagCopyList: [],
    // Tags to force-add to EVERY bridged broker contact, regardless of whether the
    // master carries them. Use for campaign/product tags that live downstream of the
    // master (e.g. "Veterans", "Valor Assurance") but must trigger broker automations.
    alwaysAddTags: [],
    // HOW tags are applied — must match how the broker's workflow trigger is built:
    //   "create" — tags go in the create body, present the instant the contact is
    //              created → fires "Contact Created" triggers with a tag filter.
    //   "after"  — create tag-less, then add tags via the add-tags endpoint (a
    //              real "tag added" event) → fires "Contact Tag" / "Tag Added"
    //              triggers. Note: this leaves the contact tag-less AT creation, so
    //              a "Contact Created + tag filter" workflow will NOT enroll it.
    tagApplyMode: "create",
    // NOTE: the opt-in/attribution gate is MANDATORY and enforced unconditionally
    // in bridge.js — a lead whose master record shows no genuine opt-in evidence is
    // NEVER created in a broker. There is deliberately no setting to disable it. A
    // legacy `requireMasterEvidence` value may linger in older config files; it is
    // ignored.
    // Country calling code (digits, no +) used to canonicalize registry keys so a
    // national-format opt-out matches an E.164 record. "1" = US/Canada (NANP).
    defaultCallingCode: "1",
    // INDEPENDENT SUPPRESSION LIST (the in-app DNC backstop). Numbers here are
    // NEVER bridged/called regardless of attribution — load reassigned numbers
    // (RND), known litigators, prior complainers, and any internal do-not-contact
    // set. Enforced BEFORE the opt-in gate, and re-checked before every write.
    // Any format; canonicalized like opt-outs. Empty = off (no volume impact).
    suppressionList: [],
    // Optional consent-recency guard (days). When > 0, a lead whose master record
    // was created (dateAdded) more than this many days ago is refused as stale
    // consent. 0 = disabled (default). A proxy for consent age — document to the
    // operator that it keys off GHL's dateAdded, not a consent timestamp.
    maxConsentAgeDays: 0,
    // Optional HMAC webhook signing secret. When set, /webhook/* requires an
    // X-Bridge-Timestamp + X-Bridge-Signature (HMAC-SHA256 of `${ts}.${rawBody}`)
    // and rejects stale/invalid ones — stronger auth + replay protection than the
    // shared key alone. Empty = shared-key only (GHL's native webhook can't sign).
    webhookSigningSecret: "",
    // Optional trusted-attribution allowlist (defense-in-depth for the master as
    // trust anchor). When non-empty, a lead is bridged only if its attribution
    // values contain one of these tokens (case-insensitive substring), so forged/
    // junk attribution from an untrusted source is refused. Empty = accept any
    // genuine attribution.
    trustedAttributionSources: [],
    // Jorden's 3-part policy, documented: when true the bridge also checks the
    // NATIONAL registry (FreeDNCList) at bridge time and records the result on the
    // consent record. Attribution still honors the opt-in (rule 2), but now the
    // audit trail shows the number WAS on the national DNC and we relied on the
    // attribution exemption. Best-effort / fail-open (like the platform). Off by
    // default (adds one external lookup per bridge); the internal-DNC layer
    // (opt-out + suppression) is always absolute regardless of this flag.
    nationalDncCheck: false,
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
  fs.mkdirSync(tenant.currentTenantDir(), { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(tenant.configPath(), "utf8"));
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
  const cfg = tenant.configPath();
  const tmp = cfg + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, cfg);
}

function appendLog(entry) {
  ensureDataDir();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(tenant.logPath(), line + "\n");
}

function readLog({ limit = 200 } = {}) {
  try {
    const lines = fs.readFileSync(tenant.logPath(), "utf8").trim().split("\n");
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

/**
 * Idempotency guard (replay protection). Returns true if `key` is newly claimed
 * (caller should proceed), false if it was already seen within `ttlMs` (a replay
 * or a duplicate GHL delivery — caller should skip). Per-tenant, persisted so it
 * survives a restart; expired entries are pruned on each call. Keyed by the
 * caller (e.g. `${contactId}:${brokerKey}` or a supplied event id).
 */
function claimIdempotency(key, ttlMs = 10 * 60 * 1000) {
  if (!key) return true; // nothing to dedupe on — let it through
  ensureDataDir();
  const p = tenant.idempotencyPath();
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    seen = {};
  }
  const now = Date.now();
  for (const [k, exp] of Object.entries(seen)) {
    if (typeof exp !== "number" || exp <= now) delete seen[k];
  }
  if (Object.prototype.hasOwnProperty.call(seen, key)) return false; // duplicate within window
  seen[key] = now + ttlMs;
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(seen));
  fs.renameSync(tmp, p);
  return true;
}

/** Release a claimed idempotency key (e.g. after a transient failure) so a retry can proceed. */
function releaseIdempotency(key) {
  if (!key) return;
  const p = tenant.idempotencyPath();
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(seen, key)) return;
  delete seen[key];
  try {
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, p);
  } catch {
    /* best effort */
  }
}

/** Redact tokens for API responses. */
function redactConfig(config) {
  const mask = (t) => (t ? `…${String(t).slice(-4)}` : "");
  const { adminPassword, ...rest } = config; // legacy field — never expose it
  return {
    ...rest,
    signingSecret: config.signingSecret ? "(set)" : "",
    settings: {
      ...config.settings,
      // The webhook signing secret is a credential — never echo it back.
      webhookSigningSecret: config.settings?.webhookSigningSecret ? "(set)" : "",
    },
    master: { ...config.master, token: mask(config.master.token), tokenSet: !!config.master.token },
    brokers: Object.fromEntries(
      Object.entries(config.brokers).map(([k, b]) => [
        k,
        { ...b, token: mask(b.token), tokenSet: !!b.token },
      ])
    ),
  };
}

module.exports = { loadConfig, saveConfig, appendLog, readLog, redactConfig, claimIdempotency, releaseIdempotency, DATA_DIR };
