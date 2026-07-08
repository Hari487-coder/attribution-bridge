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

  // STRICT GATE (mandatory, no bypass): a cold (non-opted-in) contact is REFUSED
  // and NEVER created in a broker — even if a legacy config tries to disable the
  // gate via requireMasterEvidence:false (that setting is now ignored).
  const legacyOffConfig = { ...config, settings: { ...config.settings, requireMasterEvidence: false } };
  const coldStrict = await bridge.distributeLead({ contactId: "master_cold_1", brokerKey: "broker-a" }, legacyOffConfig);
  ok("cold contact REFUSED even with legacy requireMasterEvidence:false", coldStrict.ok === false && coldStrict.refused === true);
  ok("cold contact was NOT created in the broker", coldStrict.brokerContactId == null);

  // Defense in depth: the create primitive itself refuses without a verification
  // marker, so no caller can ever create a broker contact for an unverified lead.
  const noMarker = await bridge.recreateInBroker(
    { id: "x", phone: "+15551239999", createdBy: { source: "INTEGRATION" } },
    "loc_master", "t",
    { label: "broker-a", locationId: "loc_broker_a", token: "t" },
    { duplicatePolicy: "recreate", bridgeTag: "x" },
    null // no marker
  );
  ok("recreateInBroker refuses with no verification marker", noMarker.ok === false && noMarker.refused === true && noMarker.step === "no-verification");

  console.log("tag copy to broker (Anthony):");
  const masterTags = ["Veterans", "Valor Assurance", "adl", "internal-routing"];
  // "all" — every master tag carries + app tags (bridge + verified).
  const tAll = bridge.selectCarryTags(masterTags, { tagCopyMode: "all", bridgeTag: "attribution-bridge", verifiedTag: "castigliaai-verified" }, true);
  ok("tagCopy all: carries every master tag", ["Veterans", "Valor Assurance", "adl", "internal-routing"].every((t) => tAll.includes(t)));
  ok("tagCopy all: adds bridge + verified tags", tAll.includes("attribution-bridge") && tAll.includes("castigliaai-verified"));
  // "list" — only the configured tags carry (case-insensitive), routing tags dropped.
  const tList = bridge.selectCarryTags(masterTags, { tagCopyMode: "list", tagCopyList: ["veterans", "valor assurance"], bridgeTag: "attribution-bridge", verifiedTag: "castigliaai-verified" }, true);
  ok("tagCopy list: keeps configured tags (case-insensitive)", tList.includes("Veterans") && tList.includes("Valor Assurance"));
  ok("tagCopy list: drops non-listed master tags", !tList.includes("adl") && !tList.includes("internal-routing"));
  // list never fabricates a tag the master doesn't have.
  const tListMissing = bridge.selectCarryTags(["Veterans"], { tagCopyMode: "list", tagCopyList: ["Veterans", "Valor Assurance"] }, false);
  ok("tagCopy list: does not add a configured tag absent from the master", !tListMissing.includes("Valor Assurance"));
  // "none" — no master tags, but app tags still apply.
  const tNone = bridge.selectCarryTags(masterTags, { tagCopyMode: "none", bridgeTag: "attribution-bridge", verifiedTag: "castigliaai-verified" }, true);
  ok("tagCopy none: drops all master tags", !tNone.includes("Veterans") && !tNone.includes("adl"));
  ok("tagCopy none: still keeps app tags", tNone.includes("attribution-bridge") && tNone.includes("castigliaai-verified"));
  // no marker → no verified tag stamped.
  const tNoMarker = bridge.selectCarryTags(["Veterans"], { tagCopyMode: "all", bridgeTag: "attribution-bridge", verifiedTag: "castigliaai-verified" }, false);
  ok("tagCopy: verified tag omitted without a marker", !tNoMarker.includes("castigliaai-verified") && tNoMarker.includes("Veterans"));
  // case-insensitive de-dupe (master already carries the bridge tag).
  const tDupe = bridge.selectCarryTags(["Veterans", "Attribution-Bridge"], { tagCopyMode: "all", bridgeTag: "attribution-bridge" }, false);
  ok("tagCopy: de-dupes tags case-insensitively", tDupe.filter((t) => t.toLowerCase() === "attribution-bridge").length === 1);

  // End-to-end: a bridged broker contact actually receives the selected tags.
  const tagCfg = {
    master: { locationId: "loc_master", token: "t", label: "M" },
    brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } },
    settings: { duplicatePolicy: "recreate", copyCustomFields: false, bridgeTag: "attribution-bridge", verifiedTag: "castigliaai-verified", tagCopyMode: "list", tagCopyList: ["meta-lead"] },
  };
  // master_meta_1 is INTEGRATION-stamped (opted-in) with tags ["meta-lead"].
  const tagRun = await bridge.distributeLead({ contactId: "master_meta_1", brokerKey: "broker-a" }, tagCfg);
  const bridgedContact = tagRun.brokerContactId ? await ghl.getContact(tagRun.brokerContactId, "t") : null;
  ok("end-to-end: bridged broker contact carries the configured master tag", !!bridgedContact && (bridgedContact.tags || []).includes("meta-lead"));

  console.log("force-add tags (Anthony — tags NOT on the master):");
  // selectCarryTags force-adds alwaysAddTags regardless of the master's tags.
  const tForce = bridge.selectCarryTags(["state-x"], { tagCopyMode: "none", alwaysAddTags: ["Veterans", "Valor Assurance"], bridgeTag: "attribution-bridge" }, false);
  ok("alwaysAddTags force-adds tags absent from the master", tForce.includes("Veterans") && tForce.includes("Valor Assurance"));
  ok("force-add coexists with tagCopyMode none (no master tags copied)", !tForce.includes("state-x"));
  // ghl.addTags mock: adds and de-dupes case-insensitively.
  const seededId = (await ghl.createContact("loc_broker_a", { phone: "+15550808080", firstName: "TagTest" }, "t")).id;
  await ghl.addTags(seededId, ["alpha", "beta"], "t");
  await ghl.addTags(seededId, ["Alpha", "gamma"], "t"); // Alpha is a dup of alpha
  const seededAfter = await ghl.getContact(seededId, "t");
  ok("ghl.addTags adds tags via the dedicated endpoint + de-dupes", ["alpha", "beta", "gamma"].every((t) => seededAfter.tags.includes(t)) && seededAfter.tags.filter((t) => t.toLowerCase() === "alpha").length === 1);
  // end-to-end: a bridged contact gets an alwaysAddTag that is NOT on the master.
  const freshMasterId = (await ghl.createContact("loc_master", { phone: "+15551239000", firstName: "Fresh", tags: ["state-only"] }, "t")).id;
  const forceCfg = { master: { locationId: "loc_master", token: "t", label: "M" }, brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } }, settings: { duplicatePolicy: "recreate", copyCustomFields: false, bridgeTag: "attribution-bridge", verifiedTag: "castigliaai-verified", tagCopyMode: "none", alwaysAddTags: ["Veterans"] } };
  const forceRun = await bridge.distributeLead({ contactId: freshMasterId, brokerKey: "broker-a" }, forceCfg);
  const forced = forceRun.brokerContactId ? await ghl.getContact(forceRun.brokerContactId, "t") : null;
  ok("end-to-end: bridged contact gets an alwaysAddTag NOT on the master", !!forced && (forced.tags || []).some((t) => t.toLowerCase() === "veterans"));
  ok("end-to-end: recreateInBroker reports tagsApplied ok", forceRun.tagsApplied && forceRun.tagsApplied.ok === true);

  console.log("tag apply mode (Anthony — Contact-Created vs Tag-Added triggers):");
  const modeBase = { master: { locationId: "loc_master", token: "t" }, brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } }, settings: { duplicatePolicy: "recreate", copyCustomFields: false, bridgeTag: "attribution-bridge", tagCopyMode: "none", alwaysAddTags: ["Veterans"] } };
  // "create" mode: tags in the create body → present the instant the contact exists.
  const cmId = (await ghl.createContact("loc_master", { phone: "+15551239100", firstName: "CreateMode" }, "t")).id;
  const createRun = await bridge.distributeLead({ contactId: cmId, brokerKey: "broker-a" }, { ...modeBase, settings: { ...modeBase.settings, tagApplyMode: "create" } });
  const createC = createRun.brokerContactId ? await ghl.getContact(createRun.brokerContactId, "t") : null;
  ok("create mode: tag present on the contact at creation", !!createC && (createC.tags || []).some((t) => t.toLowerCase() === "veterans"));
  ok("create mode: tagsApplied.mode === create", createRun.tagsApplied && createRun.tagsApplied.mode === "create");
  // "after" mode: tags applied via the add-tags event.
  const amId = (await ghl.createContact("loc_master", { phone: "+15551239200", firstName: "AfterMode" }, "t")).id;
  const afterRun = await bridge.distributeLead({ contactId: amId, brokerKey: "broker-a" }, { ...modeBase, settings: { ...modeBase.settings, tagApplyMode: "after" } });
  const afterC = afterRun.brokerContactId ? await ghl.getContact(afterRun.brokerContactId, "t") : null;
  ok("after mode: tag present on the contact via add-tags", !!afterC && (afterC.tags || []).some((t) => t.toLowerCase() === "veterans"));
  ok("after mode: tagsApplied.mode === after", afterRun.tagsApplied && afterRun.tagsApplied.mode === "after");
  // default (unset) mode is "create".
  const dmId = (await ghl.createContact("loc_master", { phone: "+15551239300", firstName: "DefaultMode" }, "t")).id;
  const defRun = await bridge.distributeLead({ contactId: dmId, brokerKey: "broker-a" }, modeBase);
  ok("default apply mode is 'create'", defRun.tagsApplied && defRun.tagsApplied.mode === "create");

  console.log("backlog tag filter (Anthony — exclude Sold):");
  const F = bridge.contactPassesTagFilter;
  ok("no filter → passes", F(["veterans", "fb lead"], {}) === true);
  ok("exclude Sold → hides a sold contact", F(["veterans", "Sold"], { excludeTags: ["sold"] }) === false);
  ok("exclude is case-insensitive", F(["SOLD"], { excludeTags: ["sold"] }) === false);
  ok("exclude → keeps a non-sold contact", F(["veterans", "fb lead"], { excludeTags: ["sold"] }) === true);
  ok("include list → keeps a matching contact", F(["veterans", "ohio"], { includeTags: ["veterans"] }) === true);
  ok("include list → drops a non-matching contact", F(["ohio", "fb lead"], { includeTags: ["veterans"] }) === false);
  ok("exclude wins over include", F(["veterans", "sold"], { includeTags: ["veterans"], excludeTags: ["sold"] }) === false);
  ok("empty tags + include list → dropped", F([], { includeTags: ["veterans"] }) === false);
  ok("empty tags + no filter → passes", F([], {}) === true);
  // includeMode: ANY (OR, default) vs ALL (AND).
  ok("include ANY (default): one of two listed tags matches", F(["veterans"], { includeTags: ["veterans", "valor assurance"] }) === true);
  ok("include ALL: one of two present → dropped", F(["veterans"], { includeTags: ["veterans", "valor assurance"], includeMode: "all" }) === false);
  ok("include ALL: every listed tag present → passes", F(["veterans", "valor assurance", "extra"], { includeTags: ["veterans", "valor assurance"], includeMode: "all" }) === true);
  ok("include ALL is case-insensitive", F(["Veterans", "VALOR ASSURANCE"], { includeTags: ["veterans", "valor assurance"], includeMode: "all" }) === true);
  ok("include ALL still respects exclude", F(["veterans", "valor assurance", "sold"], { includeTags: ["veterans", "valor assurance"], includeMode: "all", excludeTags: ["sold"] }) === false);
  // Integration: migrateScan applies the filter and reports hiddenByTag.
  const scanCfgF = { brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } }, master: { locationId: "loc_master", token: "t" }, settings: {} };
  const scanBase = await bridge.migrateScan("broker-a", scanCfgF, {});
  const scanUnmatched = await bridge.migrateScan("broker-a", scanCfgF, { includeTags: ["no-contact-has-this-xyz"] });
  ok("migrateScan includeTags unmatched → 0 candidates, all baseline hidden",
    scanUnmatched.ok && scanUnmatched.candidates.length === 0 && scanUnmatched.hiddenByTag === scanBase.candidates.length);

  console.log("backlog master-tag filter (Anthony — filter by master's assignment tags):");
  const mtCfg = { brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } }, master: { locationId: "loc_master", token: "t" }, settings: {} };
  // broker_assign_copy: broker tags ["fb lead"]; its MASTER (master_assign_1, same
  // phone) has ["valor assurance","georgia"].
  const noM = await bridge.migrateScan("broker-a", mtCfg, {});
  ok("no master filter → no master lookup performed", noM.masterListed === 0 && noM.hiddenByMasterTag === 0);
  const mInc = await bridge.migrateScan("broker-a", mtCfg, { masterIncludeTags: ["valor assurance"] });
  ok("master include keeps a candidate by its MASTER's tag (broker copy lacks it)",
    mInc.masterListed > 0 && mInc.candidates.some((c) => c.id === "broker_assign_copy"));
  ok("master include drops candidates whose master lacks the tag",
    !mInc.candidates.some((c) => c.id === "broker_copy_1") && mInc.hiddenByMasterTag > 0);
  const bInc = await bridge.migrateScan("broker-a", mtCfg, { includeTags: ["valor assurance"] });
  ok("contrast: BROKER include hides that same candidate (its own tags lack it)",
    !bInc.candidates.some((c) => c.id === "broker_assign_copy"));
  const mExc = await bridge.migrateScan("broker-a", mtCfg, { masterExcludeTags: ["georgia"] });
  ok("master exclude hides a candidate whose MASTER carries the tag",
    !mExc.candidates.some((c) => c.id === "broker_assign_copy"));
  const mBogus = await bridge.migrateScan("broker-a", mtCfg, { masterIncludeTags: ["zzz-no-master-has-this"] });
  ok("master include unmatched → candidate hidden, master still listed",
    !mBogus.candidates.some((c) => c.id === "broker_assign_copy") && mBogus.masterListed > 0 && mBogus.masterComplete === true);
  // master include ALL (AND): master_assign_1 has ["valor assurance","georgia"].
  const mAll = await bridge.migrateScan("broker-a", mtCfg, { masterIncludeTags: ["valor assurance", "georgia"], masterIncludeMode: "all" });
  ok("master include ALL: kept when the master has BOTH tags", mAll.candidates.some((c) => c.id === "broker_assign_copy"));
  const mAllMiss = await bridge.migrateScan("broker-a", mtCfg, { masterIncludeTags: ["valor assurance", "not-on-master"], masterIncludeMode: "all" });
  ok("master include ALL: dropped when the master lacks one of the tags", !mAllMiss.candidates.some((c) => c.id === "broker_assign_copy"));

  console.log("backlog migration honors duplicate policy (Anthony):");
  const polCfg = (policy) => ({ brokers: { "broker-a": { label: "broker-a", locationId: "loc_broker_a", token: "t" } }, master: { locationId: "loc_master", token: "t" }, settings: { duplicatePolicy: policy, bridgeTag: "attribution-bridge", tagApplyMode: "create" } });
  // Register the three phones so migrateRun has a verified marker (no master needed).
  for (const p of ["+15550911001", "+15550911002", "+15550911003"]) verify.registerVerification({ phone: p, evidence: "integration_created", masterContactId: "m" });
  // SKIP → nothing migrated, original untouched.
  const rSkip = await bridge.migrateRun("broker-a", ["broker_pol_skip"], polCfg("skip"), { dryRun: false });
  ok("policy skip: leaves the contact (action skip)", rSkip.results[0].action === "skip");
  ok("policy skip: original still exists", (await ghl.getContact("broker_pol_skip", "t").catch(() => null)) !== null);
  // STRIP → original KEPT (phone cleared, history preserved) + new attributed contact.
  const rStrip = await bridge.migrateRun("broker-a", ["broker_pol_strip"], polCfg("strip"), { dryRun: false });
  ok("policy strip: action stripped-recreated + new contact", rStrip.results[0].action === "stripped-recreated" && !!rStrip.results[0].newId);
  const oldStrip = await ghl.getContact("broker_pol_strip", "t").catch(() => null);
  ok("policy strip: original KEPT with phone cleared (history preserved)", oldStrip !== null && !oldStrip.phone);
  // RECREATE → original DELETED, new created.
  const rRecreate = await bridge.migrateRun("broker-a", ["broker_pol_recreate"], polCfg("recreate"), { dryRun: false });
  ok("policy recreate: action recreated + new contact", rRecreate.results[0].action === "recreated" && !!rRecreate.results[0].newId);
  ok("policy recreate: original DELETED", (await ghl.getContact("broker_pol_recreate", "t").catch(() => null)) === null);
  // Dry-run reflects the policy without mutating.
  const rDry = await bridge.migrateRun("broker-a", ["broker_pol_skip"], polCfg("strip"), { dryRun: true });
  ok("policy dry-run reports would-strip-recreate", rDry.results[0].action === "would-strip-recreate" && rDry.results[0].policy === "strip");

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

  console.log("bulk import (master -> broker):");
  // reset registry so opted-out numbers from earlier don't skew the scan
  fs.rmSync(verify.REGISTRY_PATH, { force: true });
  const scan = await bridge.masterScan(config);
  ok("master scan returns contacts with eligibility", scan.ok && scan.contacts.length >= 3);
  const scanCold = scan.contacts.find((c) => c.id === "master_cold_1");
  const scanMeta = scan.contacts.find((c) => c.id === "master_meta_1");
  ok("scan marks cold master contact not eligible", scanCold && scanCold.verified === false);
  ok("scan marks integration master contact eligible", scanMeta && scanMeta.verified === true);

  // dry-run push: opted-in → would-bridge, cold → would-refuse
  const dry = await bridge.masterPush("broker-a", ["master_meta_1", "master_cold_1"], config, { dryRun: true });
  ok("bulk dry-run: eligible would-bridge", dry.results.find((r) => r.id === "master_meta_1").action === "would-bridge");
  ok("bulk dry-run: cold would-refuse", dry.results.find((r) => r.id === "master_cold_1").action === "would-refuse");

  // live push of an eligible contact → success (bridged, or skipped if a prior
  // test already bridged it — both mean it's now in the broker with evidence).
  const live = await bridge.masterPush("broker-a", ["master_web_1"], config, { dryRun: false });
  const act = live.results[0].action;
  ok("bulk push succeeds for an eligible contact", live.ok && (act === "bridged" || act === "skipped"));
  // a cold contact is refused by the pipeline, never created
  const liveCold = await bridge.masterPush("broker-a", ["master_cold_1"], config, { dryRun: false });
  ok("bulk push refuses a cold contact", liveCold.results[0].action === "refused");

  console.log("SOP features:");
  // 3.1 — master scan returns tags
  fs.rmSync(verify.REGISTRY_PATH, { force: true });
  const scan2 = await bridge.masterScan(config);
  const withTags = scan2.contacts.find((c) => Array.isArray(c.tags) && c.tags.length);
  ok("master scan returns tags on contacts", !!withTags);

  // 3.2 — "strip" policy: old dupe kept but phone/email cleared, new created.
  // Uses the dedicated strip fixture (master_strip_1 + broker_strip_copy).
  const ghl2 = require("../lib/ghl");
  const stripCfg = { ...config, settings: { ...config.settings, duplicatePolicy: "strip" } };
  fs.rmSync(verify.REGISTRY_PATH, { force: true });
  const stripRes = await bridge.distributeLead({ contactId: "master_strip_1", brokerKey: "broker-a" }, stripCfg);
  ok("strip policy creates a new contact", stripRes.ok && stripRes.brokerContactId);
  ok("strip policy strips (not deletes) the old dupe", Array.isArray(stripRes.strippedDuplicates) && stripRes.strippedDuplicates.includes("broker_strip_copy") && stripRes.deletedDuplicates.length === 0);
  const oldStripped = await ghl2.getContact("broker_strip_copy", "t").catch(() => null);
  ok("stripped old contact still exists with cleared phone/email", oldStripped && oldStripped.phone === "" && oldStripped.email === "");

  // 3.3 — tag→broker routing
  const rSettings = { tagRouting: { "campaign-smith": "broker-smith", "campaign-jones": "broker-jones" }, distributionTag: "adl" };
  ok("routing: matches a tag to a broker (with trigger)", bridge.resolveBrokerByTags(["adl", "campaign-jones"], rSettings).brokerKey === "broker-jones");
  ok("routing: missing trigger tag → refused", bridge.resolveBrokerByTags(["campaign-jones"], rSettings).brokerKey === null);
  ok("routing: no matching tag → refused", bridge.resolveBrokerByTags(["adl", "other"], rSettings).brokerKey === null);
  ok("routing: case-insensitive", bridge.resolveBrokerByTags(["ADL", "Campaign-Smith"], rSettings).brokerKey === "broker-smith");
  ok("routing: no trigger configured → tag alone routes", bridge.resolveBrokerByTags(["campaign-smith"], { tagRouting: { "campaign-smith": "broker-smith" }, distributionTag: "" }).brokerKey === "broker-smith");

  console.log("review fixes:");
  // routing multi-match → refuse (don't send to arbitrary broker)
  const multi = bridge.resolveBrokerByTags(["adl", "vip", "campaign-jones"], { tagRouting: { vip: "broker-vip", "campaign-jones": "broker-jones" }, distributionTag: "adl" });
  ok("routing: multiple distinct brokers → refuse", multi.brokerKey === null && /multiple routing tags/.test(multi.reason));
  // two tags → SAME broker is fine
  const same = bridge.resolveBrokerByTags(["adl", "a", "b"], { tagRouting: { a: "broker-x", b: "broker-x" }, distributionTag: "adl" });
  ok("routing: multiple tags → same broker routes", same.brokerKey === "broker-x");

  // strip must abort BEFORE mutating when the number is opted out (critical fix)
  verify.withdrawVerification("+15559990002", "test opt-out");
  const src = { id: "master_strip_2", phone: "+15559990002", tags: [] };
  const brokerObj = { locationId: "loc_broker_a", token: "t", label: "b" };
  const wres = await bridge.recreateInBroker(src, "loc_master", "t", brokerObj, { duplicatePolicy: "strip", bridgeTag: "x" }, { evidence: "integration_created" });
  ok("strip: opt-out aborts before mutating", wres.refused === true && wres.step === "withdrawn-midflight");
  const copy2 = await require("../lib/ghl").getContact("broker_strip_copy2", "t");
  ok("strip: old dupe NOT stripped when opted out (phone intact)", copy2.phone === "+15559990002");

  console.log("Tier 1 ops:");
  const backup = require("../lib/backup");
  const stats = require("../lib/stats");
  // backup bundle round-trips config + registry
  verify.registerVerification({ phone: "+15553334444", evidence: "integration_created", masterContactId: "mb1" });
  const bundle = backup.buildBundle();
  ok("backup bundle has config + registry", bundle.config && bundle.registry && bundle.kind === "attribution-bridge-backup");
  ok("bundle includes the just-registered number", !!bundle.registry[verify.registryKey("+15553334444")]);
  // wipe registry, restore, confirm it comes back
  fs.rmSync(verify.REGISTRY_PATH, { force: true });
  ok("registry wiped", verify.isVerified("+15553334444") === null);
  const rest = backup.restoreBundle(bundle);
  ok("restore succeeds", rest.ok === true);
  ok("restore brings the number back", verify.isVerified("+15553334444") !== null);
  // restore rejects a non-bundle
  ok("restore rejects junk", backup.restoreBundle({ foo: 1 }).ok === false);
  // snapshot writes + lists
  const snap = backup.writeSnapshot("test");
  ok("snapshot written", snap.ok && backup.listSnapshots().length >= 1);
  // stats aggregates the distributes done above
  const summary = stats.summarize({});
  ok("stats summarize returns a funnel", summary.totals && typeof summary.totals.received === "number" && summary.totals.received > 0);
  ok("stats tracks lastActivityAt", typeof summary.lastActivityAt === "string");

  console.log("Tier 1 review fixes:");
  // lastActivityAt() tail reader (used by /healthz) — must not read the whole log,
  // and must return the most recent entry's timestamp.
  const tailAt = stats.lastActivityAt();
  ok("lastActivityAt tail read returns an ISO timestamp", typeof tailAt === "string" && tailAt === summary.lastActivityAt);

  // OPT-OUT ALWAYS WINS across a restore: a number withdrawn AFTER a bundle was
  // taken must stay withdrawn even though the bundle recorded it as active.
  verify.registerVerification({ phone: "+15557778888", evidence: "integration_created", masterContactId: "mo1" });
  const activeBundle = backup.buildBundle(); // captures +15557778888 as active
  verify.withdrawVerification("+15557778888", "opted out after backup");
  ok("number is withdrawn before restore", verify.isWithdrawn("+15557778888") === true);
  const merged = backup.restoreBundle(activeBundle);
  ok("restore of the older bundle succeeds", merged.ok === true);
  ok("restore does NOT resurrect the opt-out", verify.isWithdrawn("+15557778888") === true && verify.isVerified("+15557778888") === null);

  // Restore must REFUSE (and change nothing) if the pre-restore snapshot can't be
  // written — never destroy the only good copy. Force the real writeSnapshot to
  // fail by putting a FILE where its backups/ directory needs to be (mkdir throws).
  const goodBundle = backup.buildBundle();
  const before = fs.readFileSync(verify.REGISTRY_PATH, "utf8");
  fs.rmSync(backup.BACKUP_DIR, { recursive: true, force: true });
  fs.writeFileSync(backup.BACKUP_DIR, "not a directory");
  const refused = backup.restoreBundle(goodBundle);
  fs.rmSync(backup.BACKUP_DIR, { force: true }); // clean up the blocking file
  ok("restore refuses when the pre-restore snapshot fails", refused.ok === false && /pre-restore snapshot/.test(refused.error));
  ok("refused restore left the registry untouched", fs.readFileSync(verify.REGISTRY_PATH, "utf8") === before);

  console.log(`\nALL ${pass} CHECKS PASSED`);
  process.exit(0);
})().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
