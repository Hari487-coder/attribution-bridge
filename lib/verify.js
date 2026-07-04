/**
 * verify.js — the "verified attribution registry" (Option 2, webapp-side).
 *
 * The bridge's original weakness: it stamped EVERY copied contact as
 * integration-created, so any master contact — opted-in or not — would bypass
 * Assistable's DNC check. This module closes that hole without an Assistable
 * backend change, by making the WEBAPP the enforcement layer:
 *
 *   1. Verify the MASTER contact's genuine opt-in (attribution / INTEGRATION /
 *      not-DND) against the source record, which the customer cannot forge —
 *      GHL sets attribution + createdBy, not the contact-update API.
 *   2. Record a durable, signed verification keyed by phone, scoped to this
 *      workspace (one master + its brokers).
 *   3. Refuse to bridge anything not verified. An opt-out (withdrawal) always
 *      wins and is never overridden.
 *
 * The HMAC signature is a tamper-evident audit artifact and a forward-compat
 * hook: if Assistable later ships real server-side verification, these records
 * (and the on-contact note marker) are what it would consume. Assistable does
 * NOT check the signature today — enforcement is the refusal in step 3, plus
 * the INTEGRATION stamp the bridge still applies to make verified calls go
 * through.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveDncAttributionEvidence, isCallDnd } = require("./compliance");
const { loadConfig, saveConfig, appendLog, DATA_DIR } = require("./store");

const REGISTRY_PATH = path.join(DATA_DIR, "registry.json");

function defaultCallingCode() {
  const cc = String(loadConfig().settings?.defaultCallingCode || "1").replace(/\D/g, "");
  return cc || "1";
}

/**
 * Canonical registry key — format-independent WITHIN the configured default
 * country, so a national-format opt-out ("07700900123") maps to the same key
 * as the E.164 master record ("+447700900123"). This is deliberately separate
 * from compliance.normalizePhone, which stays a faithful NANP-only port of
 * Assistable's own logic and must not change.
 */
function registryKey(phone) {
  const raw = String(phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "+";
  if (raw.startsWith("+")) return "+" + digits; // already E.164 — trust it
  const cc = defaultCallingCode();
  if (cc === "1") {
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    if (digits.length === 10) return "+1" + digits;
    return "+" + digits;
  }
  // Strip a single national trunk-prefix 0, then ensure the country code prefix.
  const national = digits.startsWith("0") ? digits.slice(1) : digits;
  return national.startsWith(cc) ? "+" + national : "+" + cc + national;
}

/** A registry key is plausible if it is E.164-shaped after canonicalization. */
function isPlausiblePhone(phone) {
  return /^\+\d{7,15}$/.test(registryKey(phone));
}

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  const tmp = REGISTRY_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

/** Get-or-create the HMAC signing secret (persisted in config). */
function ensureSigningSecret() {
  const config = loadConfig();
  if (config.signingSecret) return config.signingSecret;
  const secret = crypto.randomBytes(32).toString("hex");
  saveConfig({ ...config, signingSecret: secret });
  return secret;
}

function sign(phone, verifiedAt, evidence) {
  return crypto
    .createHmac("sha256", ensureSigningSecret())
    .update(`${phone}|${verifiedAt}|${evidence}`)
    .digest("hex");
}

/** Recompute + constant-time compare a marker signature. */
function verifySignature({ phone, verifiedAt, evidence, sig }) {
  const expected = sign(phone, verifiedAt, evidence);
  const a = Buffer.from(String(sig || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Assess whether a MASTER contact is genuinely opted-in and safe to bridge.
 * Returns { verified, phone, evidence } or { verified:false, phone?, reason }.
 * Order mirrors "opt-out always wins" → DND → real evidence.
 */
function assessMaster(masterContact) {
  if (!masterContact) return { verified: false, reason: "master contact not found" };
  const phone = masterContact.phone ? registryKey(masterContact.phone) : null;
  if (!phone) return { verified: false, reason: "master contact has no phone" };

  const existing = loadRegistry()[phone];
  if (existing?.status === "withdrawn") {
    return {
      verified: false,
      phone,
      reason: `number was opted out on ${existing.withdrawnAt} (${existing.withdrawnReason || "no reason"}) — refusing; an opt-out always wins.`,
    };
  }
  if (isCallDnd(masterContact)) {
    return { verified: false, phone, reason: "master contact is set DND for calling — do not bridge." };
  }
  const evidence = resolveDncAttributionEvidence(masterContact);
  if (!evidence) {
    return {
      verified: false,
      phone,
      reason:
        "master contact has no opt-in evidence (no attributionSource / lastAttributionSource / INTEGRATION createdBy) — refusing to bridge a non-opted-in lead past DNC.",
    };
  }
  return { verified: true, phone, evidence };
}

/** Record (or refresh) a verification. Returns the stored record. */
function registerVerification({ phone, evidence, masterContactId, workspaceLabel }) {
  const n = registryKey(phone);
  if (!isPlausiblePhone(phone)) {
    throw new Error(`invalid phone for verification: ${JSON.stringify(phone)}`);
  }
  const reg = loadRegistry();
  // Opt-out is sticky: never auto-resurrect a withdrawn number to active. This
  // also closes the register-clobbers-a-just-withdrawn race (opt-out always wins).
  if (reg[n]?.status === "withdrawn") {
    return reg[n];
  }
  const verifiedAt = new Date().toISOString();
  reg[n] = {
    phone: n,
    evidence,
    masterContactId: masterContactId ?? null,
    workspaceLabel: workspaceLabel ?? null,
    verifiedAt,
    status: "active",
    sig: sign(n, verifiedAt, evidence),
    withdrawnAt: null,
    withdrawnReason: null,
  };
  saveRegistry(reg);
  appendLog({ kind: "verify-register", phone: n, evidence, masterContactId: masterContactId ?? null });
  return reg[n];
}

/** Active verification record for a phone, or null. */
function isVerified(phone) {
  const r = loadRegistry()[registryKey(phone)];
  return r && r.status === "active" ? r : null;
}

/** Withdraw (opt-out). Idempotent; creates a withdrawn record even if none existed. */
function withdrawVerification(phone, reason) {
  if (!isPlausiblePhone(phone)) {
    throw new Error(`invalid phone for opt-out: ${JSON.stringify(phone)}`);
  }
  const n = registryKey(phone);
  const reg = loadRegistry();
  const existing = reg[n];
  reg[n] = {
    phone: n,
    evidence: existing?.evidence ?? null,
    masterContactId: existing?.masterContactId ?? null,
    workspaceLabel: existing?.workspaceLabel ?? null,
    verifiedAt: existing?.verifiedAt ?? null,
    sig: existing?.sig ?? null,
    status: "withdrawn",
    withdrawnAt: new Date().toISOString(),
    withdrawnReason: reason ?? "unspecified",
  };
  saveRegistry(reg);
  appendLog({ kind: "verify-withdraw", phone: n, reason: reason ?? "unspecified" });
  return reg[n];
}

function listVerifications() {
  return Object.values(loadRegistry()).sort((a, b) =>
    String(b.verifiedAt || b.withdrawnAt || "").localeCompare(String(a.verifiedAt || a.withdrawnAt || ""))
  );
}

/** Signed marker payload to stamp on a bridged broker contact (audit trail). */
function markerFor(phone) {
  const r = isVerified(phone);
  if (!r) return null;
  return { verifiedPhone: r.phone, verifiedAt: r.verifiedAt, evidence: r.evidence, sig: r.sig };
}

/**
 * True only if the number is currently withdrawn (opted out). Used for the
 * pre-write re-check that closes the mid-flight opt-out race.
 */
function isWithdrawn(phone) {
  return loadRegistry()[registryKey(phone)]?.status === "withdrawn";
}

/** One-line human-readable note body for the broker contact. Label is configurable. */
function markerNote(marker) {
  const label =
    loadConfig().settings?.verifiedNoteLabel || "Assistable attribution verified via master account";
  return `${label} | evidence=${marker.evidence} | at=${marker.verifiedAt} | sig=${marker.sig}`;
}

module.exports = {
  assessMaster,
  registerVerification,
  isVerified,
  isWithdrawn,
  withdrawVerification,
  listVerifications,
  markerFor,
  markerNote,
  verifySignature,
  registryKey,
  isPlausiblePhone,
  ensureSigningSecret,
  REGISTRY_PATH,
};
