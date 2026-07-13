/**
 * verify.js — the "verified attribution registry" (Option 2, webapp-side).
 *
 * The bridge's original weakness: it stamped EVERY copied contact as
 * integration-created, so any master contact — opted-in or not — would bypass
 * CastigliaAI's DNC check. This module closes that hole without an CastigliaAI
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
 * hook: if CastigliaAI later ships real server-side verification, these records
 * (and the on-contact note marker) are what it would consume. CastigliaAI does
 * NOT check the signature today — enforcement is the refusal in step 3, plus
 * the INTEGRATION stamp the bridge still applies to make verified calls go
 * through.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveStrictAttributionEvidence, attributionSnapshot, isCallDnd } = require("./compliance");
const { loadConfig, saveConfig, appendLog } = require("./store");
const tenant = require("./tenant");

// Per-tenant registry file, resolved per-request (falls back to the legacy
// single path outside a tenant context — see tenant.js).
const registryPath = tenant.registryPath;

function defaultCallingCode() {
  const cc = String(loadConfig().settings?.defaultCallingCode || "1").replace(/\D/g, "");
  return cc || "1";
}

/**
 * Canonical registry key — format-independent WITHIN the configured default
 * country, so a national-format opt-out ("07700900123") maps to the same key
 * as the E.164 master record ("+447700900123"). This is deliberately separate
 * from compliance.normalizePhone, which stays a faithful NANP-only port of
 * CastigliaAI's own logic and must not change.
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
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(reg) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, p);
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
  // Independent suppression backstop (RND / litigator / complainer / internal
  // DNC) — refused BEFORE attribution is even considered, whatever the evidence.
  if (isSuppressed(phone)) {
    return {
      verified: false,
      phone,
      reason: "number is on the suppression list (reassigned number / litigator / complainer / internal do-not-contact) — refusing regardless of attribution.",
    };
  }
  if (isCallDnd(masterContact)) {
    return { verified: false, phone, reason: "master contact is set DND for calling — do not bridge." };
  }
  // Optional consent-recency guard (proxy: GHL dateAdded). Off unless configured.
  const maxAgeDays = Number(loadConfig().settings?.maxConsentAgeDays || 0);
  if (maxAgeDays > 0 && masterContact.dateAdded) {
    const ageDays = (Date.now() - new Date(masterContact.dateAdded).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > maxAgeDays) {
      return {
        verified: false,
        phone,
        reason: `master record is ~${Math.round(ageDays)} days old (older than maxConsentAgeDays=${maxAgeDays}) — refusing as stale consent.`,
      };
    }
  }
  const evidence = resolveStrictAttributionEvidence(masterContact);
  if (!evidence) {
    return {
      verified: false,
      phone,
      reason:
        "master contact has no genuine marketing attribution (populated attributionSource / lastAttributionSource). A bare INTEGRATION stamp is NOT accepted — it is also what a cold-list import carries — so this lead is refused to keep cold lists off the dialer.",
    };
  }
  return { verified: true, phone, evidence, source: attributionSnapshot(masterContact) };
}

/** Record (or refresh) a verification. Returns the stored record. */
function registerVerification({ phone, evidence, masterContactId, masterLocationId, workspaceLabel, source }) {
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
    // Concrete provenance (the actual attribution values + the master record it
    // came from) so the consent record written onto the bridged contact is
    // independently re-verifiable against the unforgeable source.
    source: source ?? null,
    masterContactId: masterContactId ?? null,
    masterLocationId: masterLocationId ?? null,
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
 * True only if a marker carries a valid HMAC signature under THIS workspace's
 * signing secret. This is the enforcement check the create funnel uses so a
 * forged/poisoned registry entry (e.g. an "active" record injected via a crafted
 * restore bundle) cannot satisfy the opt-in gate — its signature won't verify.
 */
function verifyMarker(marker) {
  if (!marker) return false;
  return verifySignature({
    phone: marker.verifiedPhone,
    verifiedAt: marker.verifiedAt,
    evidence: marker.evidence,
    sig: marker.sig,
  });
}

/**
 * True only if the number is currently withdrawn (opted out). Used for the
 * pre-write re-check that closes the mid-flight opt-out race.
 */
function isWithdrawn(phone) {
  return loadRegistry()[registryKey(phone)]?.status === "withdrawn";
}

/** Canonicalized set of operator-suppressed numbers (the in-app DNC backstop). */
function suppressionSet() {
  const raw = loadConfig().settings?.suppressionList;
  const list = Array.isArray(raw) ? raw : []; // tolerate a malformed config value
  const set = new Set();
  for (const n of list) {
    try {
      if (isPlausiblePhone(n)) set.add(registryKey(n));
    } catch {
      /* skip junk entries */
    }
  }
  return set;
}

/**
 * True if the number is on this workspace's suppression list — reassigned
 * numbers (RND), litigators, prior complainers, internal do-not-contact. These
 * are refused BEFORE the opt-in gate and never bridged/called, whatever their
 * attribution. Independent of the opt-out registry.
 */
function isSuppressed(phone) {
  return suppressionSet().has(registryKey(phone));
}

/** One-line human-readable note body for the broker contact. Label is configurable. */
function markerNote(marker) {
  const label =
    loadConfig().settings?.verifiedNoteLabel || "CastigliaAI attribution verified via master account";
  return `${label} | evidence=${marker.evidence} | at=${marker.verifiedAt} | sig=${marker.sig}`;
}

// ── verifiable consent record ─────────────────────────────────────────────────
// The independently-verifiable evidence written onto every bridged contact. It
// carries the concrete attribution values AND a pointer to the unforgeable source
// (the master location + contact), so a third party (Assistable's backend, a
// compliance auditor) can re-fetch the master and confirm the opt-in itself,
// without trusting the bridge or holding any secret. The HMAC `sig` is a
// tamper-evidence layer; the AUTHORITATIVE check is re-verifying the master.
const CONSENT_VERSION = 1;

function signConsent(payloadJson) {
  return crypto.createHmac("sha256", ensureSigningSecret()).update(payloadJson).digest("hex");
}

/** Build the signed consent record for a phone from its active registry entry, or null. */
function consentEvidenceFor(phone) {
  const r = isVerified(phone);
  if (!r) return null;
  const payload = {
    v: CONSENT_VERSION,
    phone: r.phone,
    evidence: r.evidence, // first_touch | last_touch
    source: r.source ?? null, // { field, values } — the actual attribution
    master: { locationId: r.masterLocationId ?? null, contactId: r.masterContactId ?? null },
    workspace: r.workspaceLabel ?? null,
    verifiedAt: r.verifiedAt,
  };
  // Sign a stable, key-sorted serialization so the signature is reproducible.
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return { ...payload, sig: signConsent(canonical) };
}

/** Verify a consent record's HMAC under this workspace's key (tamper check). */
function verifyConsent(record) {
  if (!record || typeof record !== "object" || !record.sig) return false;
  const { sig, ...payload } = record;
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const a = Buffer.from(String(sig));
  const b = Buffer.from(signConsent(canonical));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Human-readable + machine-parseable note body for the bridged contact. The
 * <consent>…</consent> block is JSON a backend can parse; the lead line stays
 * readable in the GHL UI. Falls back to the legacy one-liner if no record.
 */
function consentNote(record, marker) {
  if (!record) return markerNote(marker);
  const label = loadConfig().settings?.verifiedNoteLabel || "CastigliaAI attribution verified via master account";
  const src = record.source?.values ? Object.entries(record.source.values).map(([k, v]) => `${k}=${v}`).join(", ") : "n/a";
  return (
    `${label} | evidence=${record.evidence} | source=${src} | ` +
    `master=${record.master.locationId ?? "?"}/${record.master.contactId ?? "?"} | at=${record.verifiedAt}\n` +
    `<consent>${JSON.stringify(record)}</consent>`
  );
}

module.exports = {
  assessMaster,
  registerVerification,
  isVerified,
  isWithdrawn,
  isSuppressed,
  withdrawVerification,
  listVerifications,
  markerFor,
  verifyMarker,
  markerNote,
  consentEvidenceFor,
  consentNote,
  verifyConsent,
  verifySignature,
  registryKey,
  isPlausiblePhone,
  ensureSigningSecret,
  registryPath,
};
