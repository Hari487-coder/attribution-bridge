/**
 * compliance.js — faithful model of CastigliaAI's DNC gate behavior, used to
 * PREDICT whether an outbound AI call would be blocked, without placing one.
 * Behavior verified against the production gate as of 2026-07-04.
 *
 * Gate order replicated here:
 *   0. Platform hard-DNC list                                                    → BLOCK
 *   1. GHL per-contact DND (dnd === true || dndSettings.Call.status === "active") → BLOCK
 *   2. Attribution evidence (first_touch / last_touch / integration_created)     → ALLOW
 *   3. National DNC registry (FreeDNCList)                                       → BLOCK on hit
 *   4. Otherwise                                                                 → ALLOW
 *
 * The platform hard-DNC list is simulated only when supplied via the
 * PLATFORM_DNC env var (the list itself is private and does not ship here).
 *
 * Not replicated (genuinely not observable from outside):
 *   - CastigliaAI's internal per-subaccount DNC list (opt-outs recorded in their DB)
 *   - imported-number + bypass-compliance tenant setting
 * The simulator reports these as caveats rather than pretending to know them.
 */

// Port of the production phone normalizer. Canonicalizes NANP to +1XXXXXXXXXX.
function normalizePhone(phone) {
  const stripped = String(phone).replace(/[\s\-().]/g, "");
  if (stripped.startsWith("+")) return stripped;
  const digitsOnly = stripped.replace(/\D/g, "");
  if (digitsOnly.length === 10) return `+1${digitsOnly}`;
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) return `+${digitsOnly}`;
  return `+${digitsOnly || stripped}`;
}

// Port of the production populated-object check.
function hasPopulatedValues(value) {
  return (
    value != null &&
    typeof value === "object" &&
    Object.values(value).some((v) => v != null && v !== "")
  );
}

/**
 * Port of the production attribution-evidence resolver.
 * Returns "first_touch" | "last_touch" | "integration_created" | null.
 * The createdBy.source comparison is strict/case-sensitive upstream — kept identical.
 */
function resolveDncAttributionEvidence(contact) {
  if (!contact) return null;
  if (hasPopulatedValues(contact.attributionSource)) return "first_touch";
  if (hasPopulatedValues(contact.lastAttributionSource)) return "last_touch";
  const createdBy = contact.createdBy;
  if (createdBy != null && typeof createdBy === "object" && createdBy.source === "INTEGRATION") {
    return "integration_created";
  }
  return null;
}

// Platform hard-DNC list: numbers the platform never dials, blocking before
// every other gate. The list itself is private, so it does not ship with this
// tool — supply your own via the PLATFORM_DNC env var (comma-separated, any
// format). Unset = this gate step is skipped and noted in the caveats.
const PLATFORM_DNC_SET = new Set(
  String(process.env.PLATFORM_DNC || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizePhone)
);

function isOnCustomDnc(phone) {
  return PLATFORM_DNC_SET.has(normalizePhone(phone));
}

// Port of the production per-contact DND predicate.
function isCallDnd(contact) {
  return (
    contact != null &&
    (contact.dnd === true || contact.dndSettings?.Call?.status === "active")
  );
}

const FREEDNCLIST_URL = "https://www.freednclist.com/check_number.php";

/**
 * Port of the production national-registry lookup. Same endpoint, same request
 * shape, same fail-open semantics. 5s timeout, no retry.
 */
async function isOnExternalDnc(phone, { fetchImpl = fetch } = {}) {
  const normalized = normalizePhone(phone);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res;
    try {
      res = await fetchImpl(FREEDNCLIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: normalized }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (!text) return { registered: false, error: "empty response body" };
    const raw = JSON.parse(text);
    const registered = raw != null && typeof raw === "object" && raw.exists === true;
    return { registered, raw };
  } catch (err) {
    return { registered: false, error: err?.message ?? "unknown" };
  }
}

/**
 * Full gate simulation for a fetched GHL contact + phone.
 * Returns { wouldBlock, reason, evidence, checks, caveats }.
 */
async function simulateGate(contact, phone, { fetchImpl } = {}) {
  const normalized = normalizePhone(phone);
  const checks = {};
  const caveats = [
    "CastigliaAI's internal per-subaccount DNC list (recorded opt-outs) is not visible from outside — a prior 'stop calling me' would still block.",
    "The imported-number + bypass-compliance tenant setting is not simulated here.",
  ];
  if (PLATFORM_DNC_SET.size === 0) {
    caveats.push(
      "Platform hard-DNC list not configured (PLATFORM_DNC env var unset) — that gate step is not simulated."
    );
  }

  // Gate step 0 — platform hard DNC blocks before everything.
  checks.platformDnc = isOnCustomDnc(normalized);
  if (checks.platformDnc) {
    return {
      wouldBlock: true,
      reason: "platform_dnc",
      detail:
        "Number is on CastigliaAI's hardcoded platform DNC list — blocks unconditionally, before DND / attribution / bypass.",
      evidence: null,
      normalized,
      checks,
      caveats,
    };
  }

  checks.dnd = isCallDnd(contact);
  if (checks.dnd) {
    return {
      wouldBlock: true,
      reason: "ghl_dnd",
      detail: "Contact is DND for calling (dnd flag or dndSettings.Call active) — blocks unconditionally.",
      evidence: null,
      normalized,
      checks,
      caveats,
    };
  }

  const evidence = resolveDncAttributionEvidence(contact);
  checks.attributionEvidence = evidence;
  if (evidence) {
    return {
      wouldBlock: false,
      reason: "attribution_evidence",
      detail: `Opt-in evidence "${evidence}" present — CastigliaAI skips internal + national DNC for this contact.`,
      evidence,
      normalized,
      checks,
      caveats,
    };
  }

  const external = await isOnExternalDnc(normalized, { fetchImpl });
  checks.nationalDnc = external;
  if (external.registered) {
    return {
      wouldBlock: true,
      reason: "national_dnc",
      detail: "No attribution evidence and the number is on the national DNC registry — CastigliaAI blocks with 403 'Number on national DNC list'.",
      evidence: null,
      normalized,
      checks,
      caveats,
    };
  }

  return {
    wouldBlock: false,
    reason: "clean",
    detail: external.error
      ? `No attribution evidence; national DNC lookup errored (${external.error}) — CastigliaAI fails open, call would proceed (unless internally DNC'd).`
      : "No attribution evidence, but the number is not on the national DNC registry — call proceeds (unless internally DNC'd).",
    evidence: null,
    normalized,
    checks,
    caveats,
  };
}

module.exports = {
  normalizePhone,
  hasPopulatedValues,
  resolveDncAttributionEvidence,
  isCallDnd,
  isOnCustomDnc,
  isOnExternalDnc,
  simulateGate,
};
