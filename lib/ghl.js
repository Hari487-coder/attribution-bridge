/**
 * ghl.js — minimal GoHighLevel (LeadConnector) API v2 client.
 *
 * Auth: per-location Private Integration Token (PIT) or agency OAuth token,
 * passed per call. Version header pinned to 2021-07-28 (contacts API).
 *
 * MOCK MODE: set env MOCK=1 (or config.mockMode) to serve deterministic
 * fixtures instead of hitting GHL — lets the whole app be exercised without
 * live credentials.
 */

const { normalizePhone } = require("./compliance");

const GHL_BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

// Compare two phones by canonical E.164 form so "(555) 123-0001", "15551230001",
// and "+15551230001" all match. GHL stores phones inconsistently across accounts.
function samePhone(a, b) {
  if (!a || !b) return false;
  return normalizePhone(a) === normalizePhone(b);
}

class GhlError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "GhlError";
    this.status = status;
    this.body = body;
  }
}

function isMock() {
  return process.env.MOCK === "1";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghlFetch(path, { token, method = "GET", body, query, retryOn429 = 2 } = {}) {
  const url = new URL(GHL_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  // Idempotent methods can be safely retried on server errors / network blips.
  // POST is NOT retried on 5xx (the create may have landed), only on the
  // rate-limit (429) and pre-response connection failures below.
  const idempotent = method === "GET" || method === "PUT" || method === "DELETE";
  const backoff = (attempt) => 700 * 2 ** attempt + Math.floor(Math.random() * 300);

  let res;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // Only retry methods that are SAFE to repeat. This catch fires for both a
      // pre-response connection failure AND a 15s timeout abort — and an abort
      // does NOT prove the request never reached GHL. Retrying a POST here could
      // create a DUPLICATE contact (GHL doesn't dedupe phones on every location),
      // which is exactly the double-dial outcome this app exists to prevent. So
      // POST is never retried on an exception; only idempotent GET/PUT/DELETE are.
      if (idempotent && attempt < retryOn429) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    // GHL rate limit — back off and retry (safe for POST: a 429 means GHL
    // rejected the request before processing it, so nothing was created).
    // Respect Retry-After but CLAMP it: a hostile/huge value (GHL can send e.g.
    // 3600) must never park a live webhook request for minutes.
    if (res.status === 429 && attempt < retryOn429) {
      const ra = Number(res.headers.get("retry-after"));
      const raMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt);
      await sleep(Math.min(raMs, 20_000));
      continue;
    }
    // Transient upstream error on an idempotent call — retry with backoff.
    if (idempotent && res.status >= 500 && res.status <= 599 && attempt < retryOn429) {
      await sleep(backoff(attempt));
      continue;
    }
    break;
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || `GHL ${method} ${path} → HTTP ${res.status}`;
    throw new GhlError(Array.isArray(msg) ? msg.join("; ") : msg, res.status, json ?? text);
  }
  return json;
}

// ── Mock fixtures ────────────────────────────────────────────────────────────

const mockDb = {
  contacts: new Map(), // id → contact
  nextId: 1,
};

function mockContact(overrides = {}) {
  const id = overrides.id || `mock_${mockDb.nextId++}`;
  const c = {
    id,
    locationId: overrides.locationId || "loc_master",
    firstName: overrides.firstName ?? "Jane",
    lastName: overrides.lastName ?? "Lead",
    email: overrides.email ?? "jane@example.com",
    phone: overrides.phone ?? "+15551230001",
    tags: overrides.tags ?? ["meta-lead"],
    dnd: overrides.dnd ?? false,
    dndSettings: overrides.dndSettings,
    source: overrides.source ?? "facebook lead form",
    customFields: overrides.customFields ?? [{ id: "cf_master_1", value: "gold" }],
    attributionSource: overrides.attributionSource,
    lastAttributionSource: overrides.lastAttributionSource,
    createdBy: overrides.createdBy,
    dateAdded: new Date().toISOString(),
  };
  mockDb.contacts.set(id, c);
  return c;
}

function seedMocks() {
  if (mockDb.contacts.size > 0) return;
  // Master contact: Meta lead-form arrival (integration-created, no web attribution)
  mockContact({
    id: "master_meta_1",
    locationId: "loc_master",
    phone: "+15551230001",
    createdBy: { source: "INTEGRATION", channel: "OAUTH", sourceId: "app_meta_sync" },
  });
  // Master contact: landing-page funnel lead (first-touch attribution)
  mockContact({
    id: "master_web_1",
    locationId: "loc_master",
    firstName: "Web",
    phone: "+15551230002",
    attributionSource: { sessionSource: "Social media", utmSource: "ig", medium: "paid" },
  });
  // Master contact: a COLD contact dumped into master (no attribution, USER-created).
  // The verify-first gate must REFUSE to bridge this one.
  mockContact({
    id: "master_cold_1",
    locationId: "loc_master",
    firstName: "Cold",
    phone: "+15551230009",
    createdBy: { source: "USER", channel: "MANUAL" },
  });
  // Broker contact: what GHL "Copy Contact" produces — attribution stripped
  mockContact({
    id: "broker_copy_1",
    locationId: "loc_broker_a",
    phone: "+15551230001",
    createdBy: { source: "USER", channel: "COPY" },
  });
  // Broker contact: DND set
  mockContact({
    id: "broker_dnd_1",
    locationId: "loc_broker_a",
    firstName: "Dnd",
    phone: "+15551230003",
    dnd: true,
    createdBy: { source: "INTEGRATION" },
  });
  // Strip-test pair: an eligible master lead + a USER-stamped old broker copy
  // sharing a phone, used to exercise duplicatePolicy "strip".
  mockContact({
    id: "master_strip_1",
    locationId: "loc_master",
    firstName: "Strip",
    phone: "+15559990001",
    email: "strip@example.com",
    tags: ["adl", "campaign-strip"],
    createdBy: { source: "INTEGRATION" },
  });
  mockContact({
    id: "broker_strip_copy",
    locationId: "loc_broker_a",
    firstName: "StripOld",
    phone: "+15559990001",
    email: "stripold@example.com",
    createdBy: { source: "USER", channel: "COPY" },
  });
  // Second strip dupe, used to test that an opt-out aborts BEFORE stripping.
  mockContact({
    id: "broker_strip_copy2",
    locationId: "loc_broker_a",
    firstName: "StripOld2",
    phone: "+15559990002",
    email: "stripold2@example.com",
    createdBy: { source: "USER", channel: "COPY" },
  });
}

// ── API surface ──────────────────────────────────────────────────────────────

async function getContact(contactId, token) {
  if (isMock()) {
    seedMocks();
    const c = mockDb.contacts.get(contactId);
    if (!c) throw new GhlError("Contact not found (mock)", 404, null);
    return c;
  }
  const data = await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, { token });
  return data?.contact ?? data;
}

/** Search contacts by exact phone within a location. Returns array (possibly empty). */
async function searchByPhone(locationId, phone, token) {
  if (isMock()) {
    seedMocks();
    return [...mockDb.contacts.values()].filter(
      (c) => c.locationId === locationId && samePhone(c.phone, phone)
    );
  }
  try {
    const data = await ghlFetch("/contacts/search", {
      token,
      method: "POST",
      body: {
        locationId,
        pageLimit: 20,
        filters: [{ field: "phone", operator: "eq", value: phone }],
      },
    });
    return data?.contacts ?? [];
  } catch (err) {
    // Search schema varies across GHL accounts/app versions — fall back to the
    // plain list endpoint's query param and filter to exact phone locally.
    if (err instanceof GhlError && [400, 404, 422].includes(err.status)) {
      const data = await ghlFetch("/contacts/", {
        token,
        query: { locationId, query: phone, limit: 20 },
      });
      return (data?.contacts ?? []).filter((c) => samePhone(c.phone, phone));
    }
    throw err;
  }
}

/**
 * Create a contact. IMPORTANT: uses POST /contacts/ (create), NOT /contacts/upsert —
 * upsert against an existing record would keep the old createdBy stamp, which is
 * the exact thing this app exists to control.
 */
async function createContact(locationId, fields, token) {
  if (isMock()) {
    seedMocks();
    const dup = [...mockDb.contacts.values()].find(
      (c) => c.locationId === locationId && samePhone(c.phone, fields.phone)
    );
    if (dup) {
      throw new GhlError("This location does not allow duplicated contacts. (mock)", 400, {
        meta: { contactId: dup.id },
      });
    }
    // Mock assumption: API-created contacts get the INTEGRATION stamp. The
    // real-world stamp for a PIT vs OAuth app is exactly what "Test channel"
    // verifies against live GHL.
    return mockContact({
      ...fields,
      locationId,
      customFields: fields.customFields,
      createdBy: { source: "INTEGRATION", channel: "API" },
    });
  }
  const data = await ghlFetch("/contacts/", {
    token,
    method: "POST",
    body: { locationId, ...fields },
  });
  return data?.contact ?? data;
}

/**
 * Update a contact (partial). Used to strip phone/email off an old duplicate
 * (Option A) so a new attribution-carrying record can be created without a
 * dedupe conflict, while keeping the old contact and its conversation history.
 */
async function updateContact(contactId, fields, token) {
  if (isMock()) {
    seedMocks();
    const c = mockDb.contacts.get(contactId);
    if (!c) throw new GhlError("Contact not found (mock)", 404, null);
    Object.assign(c, fields);
    return c;
  }
  const data = await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, {
    token,
    method: "PUT",
    body: fields,
  });
  return data?.contact ?? data;
}

async function deleteContact(contactId, token) {
  if (isMock()) {
    seedMocks();
    if (!mockDb.contacts.has(contactId)) throw new GhlError("Contact not found (mock)", 404, null);
    mockDb.contacts.delete(contactId);
    return { succeded: true };
  }
  return ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, { token, method: "DELETE" });
}

/** Append a note to a contact (used for the signed verification audit marker). */
async function createContactNote(contactId, body, token) {
  if (isMock()) {
    seedMocks();
    const c = mockDb.contacts.get(contactId);
    if (c) c.notes = [...(c.notes ?? []), { body }];
    return { note: { id: `note_${mockDb.nextId++}`, body } };
  }
  return ghlFetch(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    token,
    method: "POST",
    body: { body },
  });
}

/** List contacts in a location (paginated). Returns { contacts, meta }. */
async function listContacts(locationId, token, { limit = 100, startAfterId, startAfter } = {}) {
  if (isMock()) {
    seedMocks();
    return {
      contacts: [...mockDb.contacts.values()].filter((c) => c.locationId === locationId),
      meta: {},
    };
  }
  const data = await ghlFetch("/contacts/", {
    token,
    query: { locationId, limit, startAfterId, startAfter },
  });
  return { contacts: data?.contacts ?? [], meta: data?.meta ?? {} };
}

/** Custom field definitions for a location: [{id, name, fieldKey, dataType}] */
async function getCustomFields(locationId, token) {
  if (isMock()) {
    return locationId === "loc_master"
      ? [{ id: "cf_master_1", name: "Tier", fieldKey: "contact.tier" }]
      : [{ id: "cf_broker_1", name: "Tier", fieldKey: "contact.tier" }];
  }
  const data = await ghlFetch(`/locations/${encodeURIComponent(locationId)}/customFields`, {
    token,
  });
  return data?.customFields ?? [];
}

module.exports = {
  GhlError,
  isMock,
  getContact,
  searchByPhone,
  createContact,
  createContactNote,
  updateContact,
  deleteContact,
  listContacts,
  getCustomFields,
};
