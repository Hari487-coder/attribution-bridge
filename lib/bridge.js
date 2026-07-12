/**
 * bridge.js — the core flows:
 *
 *  distributeLead : master contact → integration-created copy in a broker location
 *  testChannel    : create+inspect+delete a disposable contact to verify which
 *                   createdBy.source stamp the location's token actually produces
 *  migrateScan    : find broker contacts whose stamp would fail CastigliaAI's check
 *  migrateRun     : delete + recreate those contacts through the API channel
 *
 * Everything funnels through recreateInBroker so field/tag/custom-field mapping
 * is identical for live distribution and backlog migration.
 */

const ghl = require("./ghl");
const { resolveDncAttributionEvidence, normalizePhone } = require("./compliance");
const { appendLog } = require("./store");
const verify = require("./verify");

// Standard fields safe to carry from a source contact into a create body.
const COPY_FIELDS = [
  "firstName",
  "lastName",
  "name",
  "email",
  "phone",
  "address1",
  "city",
  "state",
  "postalCode",
  "country",
  "companyName",
  "website",
  "timezone",
  "dnd",
  "source",
];

const fieldDefCache = new Map(); // locationId → { at, defs }
const FIELD_DEF_TTL_MS = 10 * 60 * 1000;

async function getFieldDefs(locationId, token) {
  const hit = fieldDefCache.get(locationId);
  if (hit && Date.now() - hit.at < FIELD_DEF_TTL_MS) return hit.defs;
  const defs = await ghl.getCustomFields(locationId, token);
  fieldDefCache.set(locationId, { at: Date.now(), defs });
  return defs;
}

/**
 * Map source-contact customFields ([{id, value}]) into target-location field ids
 * by matching fieldKey. Returns { mapped: [{id, value}], unmatched: [fieldKey] }.
 */
async function mapCustomFields(sourceContact, sourceLoc, targetLoc, sourceToken, targetToken) {
  const src = Array.isArray(sourceContact.customFields) ? sourceContact.customFields : [];
  if (src.length === 0) return { mapped: [], unmatched: [] };

  const [srcDefs, tgtDefs] = await Promise.all([
    getFieldDefs(sourceLoc, sourceToken),
    getFieldDefs(targetLoc, targetToken),
  ]);
  const srcById = new Map(srcDefs.map((d) => [d.id, d]));
  const tgtByKey = new Map(tgtDefs.map((d) => [d.fieldKey, d]));

  const mapped = [];
  const unmatched = [];
  for (const cf of src) {
    if (cf.value == null || cf.value === "") continue;
    const def = srcById.get(cf.id);
    if (!def) {
      unmatched.push(cf.id);
      continue;
    }
    const tgt = tgtByKey.get(def.fieldKey);
    if (!tgt) {
      unmatched.push(def.fieldKey);
      continue;
    }
    mapped.push({ id: tgt.id, value: cf.value });
  }
  return { mapped, unmatched };
}

function buildCreateBody(sourceContact, { tags, customFields }) {
  const body = {};
  for (const f of COPY_FIELDS) {
    if (sourceContact[f] != null && sourceContact[f] !== "") body[f] = sourceContact[f];
  }
  // Write phones in canonical E.164 so later duplicate searches (which normalize)
  // can find contacts this app created.
  if (body.phone) body.phone = normalizePhone(body.phone);
  if (tags?.length) body.tags = tags;
  if (customFields?.length) body.customFields = customFields;
  return body;
}

/**
 * Decide which tags the bridged BROKER contact should carry, so the broker's
 * tag-triggered workflows fire. The bridge reads tags from the master contact
 * itself (GHL doesn't need to send them in the webhook).
 *   settings.tagCopyMode "all"  → every master tag
 *                        "list" → only master tags named in settings.tagCopyList
 *                                  (case-insensitive; never fabricates a tag the
 *                                  lead doesn't actually have)
 *                        "none" → no master tags
 * The app's own bridgeTag and (when verified) verifiedTag are always added.
 */
function selectCarryTags(sourceTags, settings = {}, hasMarker = false) {
  const src = (Array.isArray(sourceTags) ? sourceTags : [])
    .filter((t) => typeof t === "string" && t.trim());
  const mode = settings.tagCopyMode || "all";
  let carried;
  if (mode === "none") {
    carried = [];
  } else if (mode === "list") {
    const allow = new Set(
      (Array.isArray(settings.tagCopyList) ? settings.tagCopyList : [])
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean)
    );
    carried = src.filter((t) => allow.has(t.trim().toLowerCase()));
  } else {
    carried = src; // "all"
  }
  // Force-added tags (applied to every bridged contact regardless of the master).
  const forced = (Array.isArray(settings.alwaysAddTags) ? settings.alwaysAddTags : [])
    .map((t) => String(t).trim())
    .filter(Boolean);
  const appTags = [settings.bridgeTag, hasMarker ? settings.verifiedTag || "castigliaai-verified" : null];
  // De-dupe case-insensitively while preserving the first-seen casing.
  const seen = new Set();
  const out = [];
  for (const t of [...carried, ...forced, ...appTags]) {
    if (!t) continue;
    const k = t.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Create a copy of sourceContact in the broker location through the API channel,
 * honoring duplicatePolicy, then re-fetch to verify the createdBy stamp.
 */
async function recreateInBroker(sourceContact, sourceLoc, sourceToken, broker, settings, marker) {
  // Hard gate (defense in depth): NEVER create a broker contact without a signed
  // verification marker. The marker only exists after assessMaster confirmed the
  // master's opt-in/attribution and the number is not opted out. This makes the
  // create primitive itself safe — no caller, present or future, can bridge a
  // non-opted-in lead even by mistake.
  if (!marker || !verify.verifyMarker(marker)) {
    return {
      ok: false,
      refused: true,
      step: "no-verification",
      reason:
        "refusing to create a broker contact without a cryptographically valid opt-in marker — attribution/opt-in evidence (signed under this workspace's key) is required for every bridged lead.",
    };
  }
  const phone = sourceContact.phone ? normalizePhone(sourceContact.phone) : null;
  if (!phone) {
    return { ok: false, step: "precheck", error: "source contact has no phone" };
  }

  // Opt-out re-check BEFORE any destructive mutation (strip/delete). If the
  // number was opted out while we were assessing, abort now — never mutate an
  // existing broker contact for a lead that must not be called. (Mirrors the
  // ordering in migrateRun, which checks isWithdrawn before deleting.)
  if (verify.isWithdrawn(phone)) {
    return {
      ok: false,
      refused: true,
      step: "withdrawn-midflight",
      reason: "number was opted out during processing — aborting bridge (opt-out always wins).",
    };
  }

  // Duplicate handling
  const existing = await ghl.searchByPhone(broker.locationId, phone, broker.token);
  const dupes = existing.filter((c) => c.id !== sourceContact.id);
  let deleted = [];
  let stripped = [];
  if (dupes.length > 0) {
    const alreadyGood = dupes.find(
      (c) => resolveDncAttributionEvidence(c) != null
    );
    if (alreadyGood) {
      return {
        ok: true,
        skipped: true,
        step: "duplicate",
        detail: `Broker already has contact ${alreadyGood.id} with passing evidence — nothing to do.`,
        brokerContactId: alreadyGood.id,
      };
    }
    const policy = settings.duplicatePolicy;
    if (policy !== "recreate" && policy !== "strip") {
      return {
        ok: false,
        skipped: true,
        step: "duplicate",
        error: `Broker already has ${dupes.length} contact(s) for ${phone} without passing evidence (ids: ${dupes.map((c) => c.id).join(", ")}). duplicatePolicy is "skip" — set "strip" (keep the old record, clear its phone/email) or "recreate" (delete it) to replace them.`,
      };
    }
    // Snapshot every duplicate BEFORE mutating so it is recoverable from
    // activity.jsonl if the create below fails.
    for (const d of dupes) {
      appendLog({ kind: "pre-mutate-backup", context: "recreateInBroker", policy, locationId: broker.locationId, contact: d });
    }
    if (policy === "strip") {
      // Option A: keep the old contact (and its conversation history) but clear
      // its phone + email so the new attribution-carrying create won't collide
      // on GHL dedupe. Read back to confirm the clear actually took — some GHL
      // setups ignore ""; if the phone still matches, abort loudly rather than
      // let the create silently collide.
      for (const d of dupes) {
        await ghl.updateContact(d.id, { phone: "", email: "" }, broker.token);
        stripped.push(d.id);
        const after = await ghl.getContact(d.id, broker.token).catch(() => null);
        if (after && after.phone && normalizePhone(after.phone) === phone) {
          return {
            ok: false,
            step: "strip",
            error: `Stripped ${d.id} but its phone did not clear (GHL ignored the empty value), so a new create would still collide. Use "recreate" for this broker, or clear the old contact's phone manually.`,
            strippedDuplicates: stripped,
            deletedDuplicates: deleted,
            recovery: `Old contact(s) ${stripped.join(", ")} were sent a clear-phone/email update; snapshots are in the activity log as "pre-mutate-backup".`,
          };
        }
      }
    } else {
      // Option B: delete the old copy entirely.
      for (const d of dupes) {
        await ghl.deleteContact(d.id, broker.token);
        deleted.push(d.id);
      }
    }
  }

  // Custom field mapping (best-effort — a mapping failure must not lose the lead)
  let cfResult = { mapped: [], unmatched: [] };
  if (settings.copyCustomFields) {
    try {
      cfResult = await mapCustomFields(
        sourceContact,
        sourceLoc,
        broker.locationId,
        sourceToken,
        broker.token
      );
    } catch (err) {
      cfResult = { mapped: [], unmatched: [], error: err.message };
    }
  }

  const tags = selectCarryTags(sourceContact.tags, settings, !!marker);
  // Tag apply mode decides which broker workflow triggers fire (see store.js):
  //   "create" — tags in the create body (present at creation → fires
  //              "Contact Created + tag filter" triggers, the common case).
  //   "after"  — create tag-less, then add via the add-tags endpoint (a real
  //              "tag added" event → fires "Contact Tag"/"Tag Added" triggers).
  const applyMode = settings.tagApplyMode === "after" ? "after" : "create";
  const body = buildCreateBody(
    sourceContact,
    applyMode === "after" ? { customFields: cfResult.mapped } : { tags, customFields: cfResult.mapped }
  );

  let created;
  try {
    created = await ghl.createContact(broker.locationId, body, broker.token);
  } catch (err) {
    // If we mutated duplicates above, the create failure means those records
    // were changed/removed — surface that loudly and point at the backup log.
    const touched = deleted.length + stripped.length;
    return {
      ok: false,
      step: "create",
      error: err.message,
      status: err.status,
      deletedDuplicates: deleted,
      strippedDuplicates: stripped,
      recovery:
        touched > 0
          ? `Create failed AFTER ${deleted.length ? `deleting ${deleted.join(", ")}` : ""}${deleted.length && stripped.length ? " and " : ""}${stripped.length ? `stripping ${stripped.join(", ")}` : ""}. Full snapshots are in the activity log as "pre-mutate-backup" — restore manually if needed.`
          : undefined,
    };
  }
  const createdId = created?.id;

  // In "after" mode, apply tags now via the dedicated add-tags endpoint (a real
  // "tag added" event). In "create" mode the tags were already set in the body.
  // Best-effort: a tag failure must not fail the bridge (the contact is already
  // created with the INTEGRATION stamp), but it is surfaced so a token-scope
  // issue is visible.
  let tagsApplied = { ok: true, tags, mode: applyMode };
  if (createdId && tags.length && applyMode === "after") {
    try {
      await ghl.addTags(createdId, tags, broker.token);
    } catch (err) {
      tagsApplied = { ok: false, error: err.message, tags, mode: applyMode };
    }
  }

  // Stamp the signed verification marker as a contact note (best-effort audit
  // trail — a note failure must not fail the bridge).
  let markerNoteWritten = false;
  if (marker && createdId) {
    try {
      await ghl.createContactNote(createdId, verify.markerNote(marker), broker.token);
      markerNoteWritten = true;
    } catch {
      /* audit note is non-critical; the registry remains the source of truth */
    }
  }

  // Verify the stamp — this is the whole point of the app.
  let verification = { fetched: false };
  try {
    const fetched = await ghl.getContact(createdId, broker.token);
    const evidence = resolveDncAttributionEvidence(fetched);
    verification = {
      fetched: true,
      createdBySource: fetched?.createdBy?.source ?? null,
      evidence,
      passes: evidence != null,
    };
  } catch (err) {
    verification = { fetched: false, error: err.message };
  }

  return {
    ok: true,
    brokerContactId: createdId,
    deletedDuplicates: deleted,
    strippedDuplicates: stripped,
    customFields: cfResult,
    tags,
    tagsApplied,
    markerNoteWritten,
    verification,
  };
}

// In-process serialization: GHL retries webhooks, so the same lead can arrive
// twice concurrently. Chaining runs for the same broker+contact through one
/**
 * Resolve which broker a contact should route to from its tags (SOP 3.3).
 * - If a distributionTag is configured, the contact must carry it to be eligible
 *   (mirrors the GHL drip "adl" trigger, SOP 3.3.1).
 * - The destination broker is the first contact tag that maps in tagRouting.
 * Matching is case-insensitive. Returns { brokerKey } or { brokerKey:null, reason }.
 */
function resolveBrokerByTags(tags, settings = {}) {
  const have = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase()));
  const trigger = String(settings.distributionTag || "").trim().toLowerCase();
  if (trigger && !have.has(trigger)) {
    return { brokerKey: null, reason: `contact is missing the distribution trigger tag "${settings.distributionTag}"` };
  }
  const routing = settings.tagRouting || {};
  const matches = [];
  for (const [tag, brokerKey] of Object.entries(routing)) {
    if (have.has(String(tag).toLowerCase())) matches.push({ tag, brokerKey });
  }
  const distinctBrokers = [...new Set(matches.map((m) => m.brokerKey))];
  if (distinctBrokers.length === 0) {
    return { brokerKey: null, reason: "no routing tag on the contact matched the tag→broker map" };
  }
  if (distinctBrokers.length > 1) {
    // Ambiguous — the contact's tags map to more than one broker. Refuse rather
    // than deliver a lead's PII to an arbitrary broker (insertion-order tie-break).
    return {
      brokerKey: null,
      reason: `contact matched multiple routing tags pointing at different brokers (${matches.map((m) => `${m.tag}→${m.brokerKey}`).join(", ")}) — cannot disambiguate; add explicit broker_key or fix the routing map`,
    };
  }
  return { brokerKey: distinctBrokers[0], matchedTag: matches.map((m) => m.tag).join(",") };
}

// promise closes the search-then-create race (single process, so a Map suffices).
const distLocks = new Map();

function serialize(key, fn) {
  const prev = distLocks.get(key) ?? Promise.resolve();
  // Run fn after prev settles (success or failure), so runs never interleave.
  const gate = prev.then(fn, fn);
  // Tail used only for chaining — swallow rejections so one failure doesn't
  // reject the next caller's gate. Drop the entry once this is the tail.
  const tail = gate.catch(() => {});
  distLocks.set(key, tail);
  tail.then(() => {
    if (distLocks.get(key) === tail) distLocks.delete(key);
  });
  return gate;
}

/**
 * Live distribution: webhook payload names a master contact + target broker.
 */
async function distributeLead({ contactId, brokerKey }, config) {
  const broker = config.brokers[brokerKey];
  if (!broker) {
    return { ok: false, error: `Unknown broker key "${brokerKey}" — configure it in Setup.` };
  }
  if (!config.master.token || !config.master.locationId) {
    return { ok: false, error: "Master location/token not configured." };
  }

  return serialize(`${brokerKey}::${contactId}`, async () => {
    const master = await ghl.getContact(contactId, config.master.token);

    // ── Verify-first gate (MANDATORY — no bypass) ──
    // Verify the MASTER's genuine opt-in before bridging. The master record's
    // attribution / createdBy are set by GHL, not customer-writable, so this is
    // the trustworthy check. A lead with no opt-in/attribution evidence is NEVER
    // created in a broker — this is unconditional and cannot be turned off.
    const assessment = verify.assessMaster(master);
    if (!assessment.verified) {
      const refusal = {
        kind: "distribute",
        brokerKey,
        masterContactId: contactId,
        phone: assessment.phone ?? null,
        ok: false,
        refused: true,
        reason: assessment.reason,
      };
      appendLog(refusal);
      return refusal;
    }

    // Record (or refresh) the verification, then bridge with the signed marker.
    // (assessment.verified is guaranteed true here — the gate above returned
    // otherwise — so we always compute a marker before any create.)
    verify.registerVerification({
      phone: assessment.phone,
      evidence: assessment.evidence,
      masterContactId: contactId,
      workspaceLabel: config.master.label,
    });
    const marker = verify.markerFor(assessment.phone);
    // If an opt-out landed between assessMaster and here, registerVerification
    // stayed withdrawn (sticky) and markerFor is null — refuse, opt-out wins.
    if (!marker) {
      const refusal = {
        kind: "distribute",
        brokerKey,
        masterContactId: contactId,
        phone: assessment.phone,
        ok: false,
        refused: true,
        reason: "number was opted out during processing — aborting bridge (opt-out always wins).",
      };
      appendLog(refusal);
      return refusal;
    }

    const result = await recreateInBroker(
      master,
      config.master.locationId,
      config.master.token,
      broker,
      config.settings,
      marker
    );

    const summary = {
      kind: "distribute",
      brokerKey,
      masterContactId: contactId,
      masterEvidence: assessment.evidence ?? null,
      verified: assessment.verified,
      phone: master.phone ? normalizePhone(master.phone) : null,
      ...result,
    };
    appendLog(summary);
    return summary;
  });
}

/**
 * Channel test: creates a throwaway contact in the broker location, inspects the
 * createdBy stamp GHL actually assigns for that token type, then deletes it.
 */
async function testChannel(brokerKey, config) {
  const broker = brokerKey === "master" ? config.master : config.brokers[brokerKey];
  if (!broker?.token || !broker?.locationId) {
    return { ok: false, error: `Broker "${brokerKey}" missing token/locationId.` };
  }
  // 4+ distinct digits from the numeric clock (not letter-stripped base36, which
  // collapsed to a ~1-in-5 collision rate). +1 555 01XX range is fictional/non-dialable.
  const suffix = String(Date.now() % 100000).padStart(5, "0");
  const testPhone = `+1555${suffix}`;
  const testBody = {
    firstName: "BridgeTest",
    lastName: Date.now().toString(36),
    phone: testPhone,
    tags: ["attribution-bridge-test"],
    source: "attribution-bridge channel test",
  };
  let created;
  try {
    created = await ghl.createContact(broker.locationId, testBody, broker.token);
  } catch (err) {
    // A leftover test contact from an earlier run (delete was best-effort) collides
    // on the reserved phone. Clean it up and retry once so the verdict isn't
    // misread as a broken channel.
    const staleId = err?.body?.meta?.contactId;
    if (staleId) {
      try {
        await ghl.deleteContact(staleId, broker.token);
        created = await ghl.createContact(broker.locationId, testBody, broker.token);
      } catch (err2) {
        return {
          ok: false,
          step: "create",
          error: `Stale test contact on ${testPhone} could not be cleared automatically: ${err2.message}`,
          status: err2.status,
        };
      }
    } else {
      return { ok: false, step: "create", error: err.message, status: err.status };
    }
  }
  let fetched = null;
  let evidence = null;
  try {
    fetched = await ghl.getContact(created.id, broker.token);
    evidence = resolveDncAttributionEvidence(fetched);
  } finally {
    try {
      await ghl.deleteContact(created.id, broker.token);
    } catch {
      /* leave orphan test contact; tagged for manual cleanup */
    }
  }
  const createdBySource = fetched?.createdBy?.source ?? null;
  const result = {
    ok: true,
    brokerKey,
    createdBySource,
    evidence,
    passes: evidence != null,
    verdict:
      evidence != null
        ? `PASS — contacts created through this token get evidence "${evidence}". CastigliaAI will allow calls.`
        : `FAIL — createdBy.source is "${createdBySource}", not "INTEGRATION". This token type won't pass the check; use a GHL OAuth-app channel (e.g. Make/Zapier GHL connection) instead.`,
  };
  appendLog({ kind: "test-channel", ...result });
  return result;
}

/**
 * Broker-side tag filter for the backlog scan. Lets the operator narrow the
 * (usually huge) candidate list by the broker contact's OWN tags:
 *   excludeTags — hide any contact carrying one of these (e.g. "Sold", "Closed"):
 *                 a contact a broker already closed must not show as re-writable.
 *   includeTags — if set, keep only contacts matching per includeMode:
 *                 "any" (default, OR) = carries at least one of these tags;
 *                 "all" (AND)         = carries every one of these tags.
 * Exclusion always wins over inclusion. Matching is case-insensitive.
 */
function contactPassesTagFilter(tags, { includeTags = [], excludeTags = [], includeMode = "any" } = {}) {
  const have = new Set(
    (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)
  );
  const inc = (Array.isArray(includeTags) ? includeTags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const exc = (Array.isArray(excludeTags) ? excludeTags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (exc.some((t) => have.has(t))) return false; // has an excluded tag → drop
  if (inc.length) {
    const matched = includeMode === "all" ? inc.every((t) => have.has(t)) : inc.some((t) => have.has(t));
    if (!matched) return false; // include list set but not matched per mode → drop
  }
  return true;
}

/**
 * Backlog scan (ONE cursor batch): page a bounded batch of a broker's contacts
 * from `startAfterId`/`startAfter`, flag the ones that would fail the evidence
 * check, and return a `nextCursor` so the caller can loop through the WHOLE
 * account without a single giant (timeout-prone, 1000-capped) request.
 *
 * Two optional tag filters narrow the list:
 *   include/excludeTags             — the BROKER contact's own tags (e.g. exclude
 *                                     already-"Sold" contacts).
 *   masterInclude/masterExcludeTags — the MASTER contact's tags, matched by phone
 *                                     (the authoritative assignment tags). Looked
 *                                     up PER broker-filtered candidate, so the work
 *                                     scales with the small candidate set — not the
 *                                     master size — with no cap and exact matches.
 */
async function migrateScan(
  brokerKey,
  config,
  { startAfterId, startAfter, pages = 3, pageSize = 100, includeTags = [], excludeTags = [], includeMode = "any", masterIncludeTags = [], masterExcludeTags = [], masterIncludeMode = "any", concurrency = 6 } = {}
) {
  const broker = config.brokers[brokerKey];
  if (!broker) return { ok: false, error: `Unknown broker key "${brokerKey}".` };

  const prelim = [];
  let scanned = 0;
  let hiddenByTag = 0;
  let cursorId = startAfterId;
  let cursorTs = startAfter;
  let nextCursor = null;
  for (let page = 0; page < pages; page++) {
    const { contacts, meta } = await ghl.listContacts(broker.locationId, broker.token, {
      limit: pageSize,
      startAfterId: cursorId,
      startAfter: cursorTs,
    });
    if (!contacts.length) {
      nextCursor = null;
      break;
    }
    scanned += contacts.length;
    for (const c of contacts) {
      const evidence = resolveDncAttributionEvidence(c);
      if (evidence == null && c.phone) {
        if (!contactPassesTagFilter(c.tags, { includeTags, excludeTags, includeMode })) {
          hiddenByTag += 1;
          continue;
        }
        prelim.push({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || "(no name)",
          phone: c.phone,
          createdBySource: c.createdBy?.source ?? null,
          tags: c.tags ?? [],
        });
      }
    }
    cursorId = meta?.startAfterId;
    cursorTs = meta?.startAfter;
    if (!cursorId) {
      nextCursor = null;
      break;
    }
    nextCursor = { startAfterId: cursorId, startAfter: cursorTs };
  }

  // Master-side tag filter — look the master up per broker-filtered candidate.
  let hiddenByMasterTag = 0;
  let candidates = prelim;
  const useMaster =
    (masterIncludeTags.length || masterExcludeTags.length) &&
    config.master?.token &&
    config.master?.locationId;
  if (useMaster && prelim.length) {
    const checked = await mapLimit(prelim, concurrency, async (cand) => {
      let mtags = null;
      try {
        const matches = await ghl.searchByPhone(config.master.locationId, normalizePhone(cand.phone), config.master.token);
        if (matches.length) {
          mtags = [...new Set(matches.flatMap((m) => (Array.isArray(m.tags) ? m.tags : [])))];
        }
      } catch {
        mtags = null; // a lookup failure is treated as "no master tags"
      }
      const pass = contactPassesTagFilter(mtags || [], {
        includeTags: masterIncludeTags,
        excludeTags: masterExcludeTags,
        includeMode: masterIncludeMode,
      });
      return pass ? { ...cand, masterTags: mtags } : null;
    });
    candidates = checked.filter(Boolean);
    hiddenByMasterTag = prelim.length - candidates.length;
  }

  appendLog({ kind: "migrate-scan", brokerKey, scanned, candidates: candidates.length, hiddenByTag, hiddenByMasterTag });
  return { ok: true, brokerKey, scanned, candidates, hiddenByTag, hiddenByMasterTag, nextCursor };
}

/**
 * Backlog migration: for each candidate id, re-fetch the full contact, then
 * delete + recreate it through the API channel. dryRun previews without writes.
 */
async function migrateRun(brokerKey, contactIds, config, { dryRun = true, overrideTags = null } = {}) {
  const broker = config.brokers[brokerKey];
  if (!broker) return { ok: false, error: `Unknown broker key "${brokerKey}".` };

  const results = [];
  for (const id of contactIds) {
    try {
      const full = await ghl.getContact(id, broker.token);
      const evidence = resolveDncAttributionEvidence(full);
      if (evidence != null) {
        results.push({ id, action: "skip", reason: `already has evidence "${evidence}"` });
        continue;
      }
      if (!full.phone) {
        results.push({ id, action: "skip", reason: "no phone on contact" });
        continue;
      }
      // Conflict pre-check: if ANOTHER contact in this location shares the phone,
      // deleting this one and recreating would hit GHL dedupe against the sibling
      // and the create would fail — losing this contact. Skip and flag instead.
      const phone = normalizePhone(full.phone);
      const siblings = (await ghl.searchByPhone(broker.locationId, phone, broker.token)).filter(
        (c) => c.id !== id
      );
      if (siblings.length > 0) {
        results.push({
          id,
          action: "skip",
          reason: `another contact shares phone ${phone} (${siblings.map((c) => c.id).join(", ")}) — recreate would collide on GHL dedupe. Resolve the duplicate first.`,
        });
        continue;
      }

      // Verify-first for backlog. The ONLY acceptable proof of opt-in is a LIVE,
      // currently-opted-in contact in the MASTER account for this phone — the
      // unforgeable evidence GHL itself sets. We deliberately do NOT trust a
      // stored registry "active" status here: app-local state can be reset or
      // restored from an uploaded bundle, so it must never be the thing that
      // authorizes a call. Re-verify against the master on every run; if opt-in
      // can't be proven live, refuse (fail closed).
      let marker = null;
      if (config.master?.token && config.master?.locationId) {
        const masterMatches = await ghl.searchByPhone(config.master.locationId, phone, config.master.token);
        const opted = masterMatches
          .map((m) => ({ m, a: verify.assessMaster(m) }))
          .find((x) => x.a.verified);
        if (opted) {
          verify.registerVerification({
            phone,
            evidence: opted.a.evidence,
            masterContactId: opted.m.id,
            workspaceLabel: config.master.label,
          });
          marker = verify.markerFor(phone); // freshly signed under this workspace's key
        }
      }
      if (!marker) {
        results.push({
          id,
          action: "skip",
          reason:
            config.master?.token && config.master?.locationId
              ? "no currently opted-in master contact for this phone — cannot prove opt-in live; bridge it from the master first."
              : "master account not configured — backlog migration re-verifies each number against the master to prove opt-in.",
        });
        continue;
      }

      // Honor the duplicate policy from Setup (same setting as the live bridge):
      //   "skip"     — leave the contact as-is (nothing migrated).
      //   "strip"    — KEEP the old contact (and its conversation history) but clear
      //                its phone/email, then create a fresh attributed contact.
      //   "recreate" — DELETE the old contact (history lost), then create fresh.
      const policy = config.settings.duplicatePolicy || "recreate";

      if (dryRun) {
        results.push({
          id,
          action: policy === "skip" ? "would-skip" : policy === "strip" ? "would-strip-recreate" : "would-recreate",
          phone,
          policy,
          verified: !!marker,
          createdBySource: full.createdBy?.source ?? null,
        });
        continue;
      }

      if (policy === "skip") {
        results.push({
          id,
          action: "skip",
          reason: 'duplicate policy is "skip" — set "strip" (keep the old contact + its history) or "recreate" (delete it) in Setup to migrate.',
        });
        continue;
      }

      // Tags for the re-created contact. If overrideTags is provided, the contact
      // gets EXACTLY those tags (its old tags and the global add-tags are NOT
      // applied) — the operator's manual set, e.g. leaving off the trigger tags so
      // re-migrating a lead doesn't restart its broker automations. Otherwise:
      // preserve ALL of the broker contact's own tags + the global force-add tags.
      const migTags = Array.isArray(overrideTags)
        ? overrideTags.map((t) => String(t).trim()).filter(Boolean)
        : selectCarryTags(full.tags, { ...config.settings, tagCopyMode: "all" }, !!marker);
      const migApplyMode = config.settings.tagApplyMode === "after" ? "after" : "create";
      const migCustomFields = (full.customFields ?? []).filter((cf) => cf.value != null && cf.value !== "");
      const body = buildCreateBody(full, migApplyMode === "after" ? { customFields: migCustomFields } : { tags: migTags, customFields: migCustomFields });
      // Re-check opt-out immediately before mutating: an opt-out may have landed
      // during the searches above (the stale-marker race).
      if (verify.isWithdrawn(phone)) {
        results.push({ id, action: "skip", reason: "number was opted out during processing — opt-out always wins." });
        continue;
      }
      // Snapshot BEFORE mutating so the contact is recoverable from activity.jsonl.
      appendLog({ kind: "pre-mutate-backup", context: "migrateRun", policy, locationId: broker.locationId, contact: full });

      if (policy === "strip") {
        // Keep the old contact + its history; clear its phone/email so the new
        // attributed contact won't collide on GHL dedupe. Read back to confirm.
        await ghl.updateContact(id, { phone: "", email: "" }, broker.token);
        const after = await ghl.getContact(id, broker.token).catch(() => null);
        if (after && after.phone && normalizePhone(after.phone) === phone) {
          results.push({
            id,
            action: "error",
            error: `Stripped ${id} but its phone did not clear (GHL ignored the empty value) — a new create would collide. Use "recreate" for this broker.`,
          });
          continue;
        }
      } else {
        await ghl.deleteContact(id, broker.token);
      }

      let created;
      try {
        created = await ghl.createContact(broker.locationId, body, broker.token);
      } catch (err) {
        const undo = policy === "strip" ? `stripped ${id} (phone/email cleared, contact kept)` : `deleted ${id}`;
        results.push({
          id,
          action: "error",
          error: err.message,
          recovery: `Create failed after ${undo} — full snapshot is in the activity log as "pre-mutate-backup".`,
        });
        continue;
      }
      if (migTags.length && migApplyMode === "after") {
        try {
          await ghl.addTags(created.id, migTags, broker.token);
        } catch {
          /* tags best-effort — the contact is already recreated with the stamp */
        }
      }
      if (marker) {
        try {
          await ghl.createContactNote(created.id, verify.markerNote(marker), broker.token);
        } catch {
          /* audit note is non-critical */
        }
      }
      const fetched = await ghl.getContact(created.id, broker.token);
      const newEvidence = resolveDncAttributionEvidence(fetched);
      results.push({
        id,
        action: policy === "strip" ? "stripped-recreated" : "recreated",
        newId: created.id,
        policy,
        createdBySource: fetched?.createdBy?.source ?? null,
        passes: newEvidence != null,
      });
    } catch (err) {
      results.push({ id, action: "error", error: err.message });
    }
  }
  appendLog({
    kind: "migrate-run",
    brokerKey,
    dryRun,
    policy: config.settings.duplicatePolicy || "recreate",
    total: contactIds.length,
    recreated: results.filter((r) => r.action === "recreated" || r.action === "stripped-recreated").length,
    errors: results.filter((r) => r.action === "error").length,
  });
  return { ok: true, brokerKey, dryRun, results };
}

/** Run fn over items with at most `limit` in flight. Preserves order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Master scan (one batch): list `pages` pages of the MASTER account from an
 * optional cursor, fetch each full contact (concurrency-limited) to assess
 * opt-in accurately, and return a `nextCursor` so the caller can continue.
 *
 * Why batched: GHL's list endpoint omits attributionSource/lastAttributionSource/
 * createdBy, so eligibility needs a full GET per contact — and GHL caps that at
 * ~10/s, so scanning a whole account in ONE request would exceed the hosting
 * proxy's ~100s timeout. Bounded batches keep every request fast; the client
 * loops through them.
 */
async function masterScan(config, { startAfterId, startAfter, pages = 3, pageSize = 100, concurrency = 4 } = {}) {
  if (!config.master?.token || !config.master?.locationId) {
    return { ok: false, error: "Master location/token not configured." };
  }
  const listed = [];
  let scanned = 0;
  let cursorId = startAfterId;
  let cursorTs = startAfter;
  let nextCursor = null;
  for (let p = 0; p < pages; p++) {
    const { contacts: batch, meta } = await ghl.listContacts(
      config.master.locationId,
      config.master.token,
      { limit: pageSize, startAfterId: cursorId, startAfter: cursorTs }
    );
    if (!batch.length) break;
    scanned += batch.length;
    for (const c of batch) listed.push(c);
    cursorId = meta?.startAfterId;
    cursorTs = meta?.startAfter;
    // No further cursor → this account has no more pages.
    if (!cursorId) {
      nextCursor = null;
      cursorId = undefined;
      break;
    }
    nextCursor = { startAfterId: cursorId, startAfter: cursorTs };
  }

  const nameOf = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || "(no name)";

  const assessed = await mapLimit(listed, concurrency, async (c) => {
    try {
      const full = await ghl.getContact(c.id, config.master.token);
      if (!full.phone) return null;
      const a = verify.assessMaster(full);
      const nm = nameOf(full);
      return {
        id: full.id || c.id,
        name: nm !== "(no name)" ? nm : nameOf(c),
        phone: full.phone,
        tags: Array.isArray(full.tags) ? full.tags : [],
        verified: a.verified,
        evidence: a.evidence ?? null,
        reason: a.verified ? null : a.reason,
      };
    } catch (err) {
      // Couldn't fetch full details (rate limit / transient) — mark unknown
      // rather than a false "not eligible"; the push re-checks authoritatively.
      return {
        id: c.id,
        name: nameOf(c),
        phone: c.phone || null,
        tags: Array.isArray(c.tags) ? c.tags : [],
        verified: null,
        evidence: null,
        reason: `couldn't fetch full details (${err.message}) — will be re-checked at push`,
      };
    }
  });
  const contacts = assessed.filter(Boolean);
  appendLog({ kind: "master-scan", scanned, eligible: contacts.filter((c) => c.verified === true).length });
  return { ok: true, scanned, contacts, nextCursor };
}

/**
 * Master push: bulk-distribute selected master contacts into a broker. Each id
 * runs through distributeLead, so it inherits the full verify-first pipeline
 * (opt-in check, opt-out wins, duplicate policy, signed marker, serialization).
 * dryRun assesses without creating.
 */
async function masterPush(brokerKey, contactIds, config, { dryRun = true } = {}) {
  const broker = config.brokers[brokerKey];
  if (!broker) return { ok: false, error: `Unknown broker key "${brokerKey}".` };
  if (!config.master?.token || !config.master?.locationId) {
    return { ok: false, error: "Master location/token not configured." };
  }

  const results = [];
  for (const id of contactIds) {
    try {
      if (dryRun) {
        const master = await ghl.getContact(id, config.master.token);
        const a = verify.assessMaster(master);
        results.push({
          id,
          action: a.verified ? "would-bridge" : "would-refuse",
          phone: a.phone ?? null,
          evidence: a.evidence ?? null,
          reason: a.verified ? null : a.reason,
        });
      } else {
        const r = await distributeLead({ contactId: id, brokerKey }, config);
        // Order matters: a skip-policy duplicate comes back ok:false + skipped:true,
        // which is a "skipped" outcome, not an "error".
        const action = r.refused
          ? "refused"
          : r.skipped
            ? "skipped"
            : r.ok
              ? "bridged"
              : "error";
        results.push({
          id,
          action,
          reason: r.reason || r.error || null,
          brokerContactId: r.brokerContactId ?? null,
          passes: r.verification?.passes ?? null,
        });
      }
    } catch (err) {
      results.push({ id, action: "error", error: err.message });
    }
  }
  appendLog({
    kind: "master-push",
    brokerKey,
    dryRun,
    total: contactIds.length,
    bridged: results.filter((r) => r.action === "bridged").length,
    errors: results.filter((r) => r.action === "error").length,
  });
  return { ok: true, brokerKey, dryRun, results };
}

module.exports = {
  distributeLead,
  testChannel,
  migrateScan,
  migrateRun,
  recreateInBroker,
  masterScan,
  masterPush,
  resolveBrokerByTags,
  selectCarryTags,
  contactPassesTagFilter,
};
