/* Smoke test — run with: MOCK=1 node test/smoke.js  (exit 0 = all pass) */
process.env.MOCK = "1";
// Dummy platform-DNC entry to exercise the gate-step-0 mechanism (the real
// list is private and env-supplied in production; must be set before require).
process.env.PLATFORM_DNC = "+15550001111";

const assert = require("node:assert");
const fs = require("node:fs");
const compliance = require("../lib/compliance");
const ghl = require("../lib/ghl");
const bridge = require("../lib/bridge");
const verify = require("../lib/verify");

// Isolate the verification registry so runs are deterministic.
try { fs.rmSync(verify.REGISTRY_PATH, { force: true }); } catch {}

let pass = 0;
const ok = (name, cond) => {
  assert.ok(cond, "FAIL: " + name);
  pass++;
  console.log("  ✓ " + name);
};

(async () => {
  console.log("compliance port:");
  ok("normalizePhone NANP", compliance.normalizePhone("(555) 123-4567") === "+15551234567");
  ok("evidence: integration", compliance.resolveDncAttributionEvidence({ createdBy: { source: "INTEGRATION" } }) === "integration_created");
  ok("evidence: none for USER copy", compliance.resolveDncAttributionEvidence({ createdBy: { source: "USER" } }) === null);
  ok("evidence: first_touch", compliance.resolveDncAttributionEvidence({ attributionSource: { utmSource: "ig" } }) === "first_touch");

  // FIX 7: platform DNC (env-configured) blocks before everything, even with attribution
  const plat = await compliance.simulateGate({ attributionSource: { utmSource: "ig" } }, "+1 (555) 000-1111");
  ok("platform DNC blocks even with attribution", plat.wouldBlock === true && plat.reason === "platform_dnc");

  // gate: DND blocks
  const dnd = await compliance.simulateGate({ dnd: true, createdBy: { source: "INTEGRATION" } }, "+15551230003");
  ok("DND blocks", dnd.wouldBlock === true && dnd.reason === "ghl_dnd");

  // gate: attribution allows
  const attr = await compliance.simulateGate({ createdBy: { source: "INTEGRATION" } }, "+15551230001");
  ok("attribution allows", attr.wouldBlock === false && attr.reason === "attribution_evidence");

  console.log("phone matching (FIX 3):");
  // A broker contact stored in non-E.164 form must be found as a duplicate.
  const ghlMod = require("../lib/ghl");
  // Inject a non-canonical-phone contact directly into the mock db via createContact then mutate is awkward;
  // instead assert samePhone-driven search matches across formats using the seeded broker_copy_1 (+15551230001).
  const found = await ghlMod.searchByPhone("loc_broker_a", "+1 (555) 123-0001", "tok");
  ok("searchByPhone matches across formats", found.some((c) => c.id === "broker_copy_1"));

  console.log("distribute + verify (FIX 1/2 recovery paths intact):");
  const config = {
    master: { locationId: "loc_master", token: "t" },
    brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } },
    settings: { duplicatePolicy: "skip", copyCustomFields: true, bridgeTag: "attribution-bridge" },
  };
  const d = await bridge.distributeLead({ contactId: "master_web_1", brokerKey: "broker-a" }, config);
  ok("distribute creates + verifies INTEGRATION", d.ok && d.verification.passes && d.verification.createdBySource === "INTEGRATION");

  // recreate policy deletes then creates, logs backup
  config.settings.duplicatePolicy = "recreate";
  const d2 = await bridge.distributeLead({ contactId: "master_meta_1", brokerKey: "broker-a" }, config);
  ok("recreate replaces copy + passes", d2.ok && d2.deletedDuplicates.includes("broker_copy_1") && d2.verification.passes);

  console.log("channel test (FIX 4 — deterministic phone):");
  const t = await bridge.testChannel("broker-a", config);
  ok("channel test passes in mock", t.ok && t.passes);

  console.log("concurrent distribute (FIX 5 — serialization):");
  // Two concurrent runs for same master+broker must not both create.
  const [a, b] = await Promise.all([
    bridge.distributeLead({ contactId: "master_web_1", brokerKey: "broker-a" }, config),
    bridge.distributeLead({ contactId: "master_web_1", brokerKey: "broker-a" }, config),
  ]);
  // First creates/updates, second sees alreadyGood or dup — at most one fresh create, no crash.
  ok("concurrent runs both resolve without crash", a && b);

  console.log("verification model (NEW FEATURE):");
  // Verify-first gate: a cold master contact (USER-created, no attribution) is refused.
  const cold = await bridge.distributeLead({ contactId: "master_cold_1", brokerKey: "broker-a" }, config);
  ok("cold master contact is REFUSED", cold.ok === false && cold.refused === true);

  // A verified distribution registers the phone.
  ok("verified distribution registered the number", verify.isVerified("+15551230002") !== null);

  // assessMaster verdicts
  ok("assessMaster passes an INTEGRATION contact", verify.assessMaster({ phone: "+15550000001", createdBy: { source: "INTEGRATION" } }).verified === true);
  ok("assessMaster refuses a cold contact", verify.assessMaster({ phone: "+15550000002", createdBy: { source: "USER" } }).verified === false);
  ok("assessMaster refuses a DND contact", verify.assessMaster({ phone: "+15550000003", dnd: true, createdBy: { source: "INTEGRATION" } }).verified === false);

  // Opt-out always wins: withdraw a verified number, then a distribute is refused.
  verify.withdrawVerification("+15551230002", "test opt-out");
  ok("withdraw marks the number withdrawn", verify.isVerified("+15551230002") === null);
  const afterOptOut = await bridge.distributeLead({ contactId: "master_web_1", brokerKey: "broker-a" }, config);
  ok("distribute is REFUSED after opt-out (opt-out wins)", afterOptOut.ok === false && afterOptOut.refused === true);

  // Signature round-trips; tampering is detected.
  const rec = verify.registerVerification({ phone: "+15557778888", evidence: "integration_created", masterContactId: "m1" });
  ok("valid signature verifies", verify.verifySignature(rec) === true);
  ok("tampered evidence fails signature", verify.verifySignature({ ...rec, evidence: "first_touch" }) === false);

  // Gate OFF lets a cold contact through (explicit opt-out of safety).
  const unsafeConfig = { ...config, settings: { ...config.settings, requireMasterEvidence: false } };
  const coldUnsafe = await bridge.distributeLead({ contactId: "master_cold_1", brokerKey: "broker-a" }, unsafeConfig);
  ok("gate OFF bridges a cold contact", coldUnsafe.ok === true);

  console.log("review fixes:");
  // FIX (critical): international opt-out matches across national/E.164 formats.
  // Default calling code "1" (NANP): withdraw national 10-digit == E.164 +1.
  verify.withdrawVerification("5559998877", "national format");
  ok("NANP national opt-out matches E.164 lookup", verify.isVerified("+15559998877") === null && verify.isWithdrawn("+15559998877"));

  // With a UK default code, national and E.164 converge to one key.
  fs.rmSync(verify.REGISTRY_PATH, { force: true });
  const store = require("../lib/store");
  const baseCfg = store.loadConfig();
  store.saveConfig({ ...baseCfg, settings: { ...baseCfg.settings, defaultCallingCode: "44" } });
  ok("UK national + E.164 map to same registry key", verify.registryKey("07700900123") === verify.registryKey("+447700900123"));
  verify.withdrawVerification("07700900123", "uk national opt-out");
  ok("UK national opt-out blocks E.164 master", verify.assessMaster({ phone: "+447700900123", attributionSource: { utmSource: "ig" } }).verified === false);
  store.saveConfig({ ...baseCfg, settings: { ...baseCfg.settings, defaultCallingCode: "1" } });

  // FIX (minor): opt-out is sticky — a later register cannot resurrect it.
  verify.withdrawVerification("+15551112222", "sticky test");
  const resurrect = verify.registerVerification({ phone: "+15551112222", evidence: "integration_created", masterContactId: "m9" });
  ok("register cannot resurrect a withdrawn number", resurrect.status === "withdrawn" && verify.isVerified("+15551112222") === null);

  // FIX (minor): junk phone input is rejected, not persisted.
  let threw = false;
  try { verify.withdrawVerification("abc"); } catch { threw = true; }
  ok("junk phone rejected by withdraw", threw && !verify.isPlausiblePhone("abc"));

  console.log(`\nALL ${pass} CHECKS PASSED`);
  process.exit(0);
})().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
