/**
 * backup.js — protect the two files that matter: config.json (broker tokens,
 * webhook key, routing) and registry.json (the signed opt-in/opt-out evidence).
 *
 * A Render disk wipe already destroyed the config once. On-disk snapshots guard
 * against in-app clobbering; the real off-box protection is the manual download
 * (lands on the operator's own machine) and the optional nightly push to a URL
 * the operator owns.
 *
 * SECURITY: a bundle contains live GHL API tokens in plaintext. The download
 * endpoint is admin-authed; the off-box push must target a private destination.
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, saveConfig, DATA_DIR, CONFIG_PATH } = require("./store");
const { REGISTRY_PATH } = require("./verify");
const { fetchWithTimeout } = require("./http-lite");

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP = 14;
const BUNDLE_VERSION = 1;

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** Assemble a full backup bundle (contains secrets). */
function buildBundle(at) {
  return {
    kind: "attribution-bridge-backup",
    version: BUNDLE_VERSION,
    at: at || new Date().toISOString(),
    config: loadConfig(),
    registry: readJson(REGISTRY_PATH, {}),
  };
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return "not an object";
  if (bundle.kind !== "attribution-bridge-backup") return "not a backup bundle (wrong kind)";
  if (!bundle.config || typeof bundle.config !== "object") return "missing config";
  if (bundle.registry != null && typeof bundle.registry !== "object") return "registry is not an object";
  return null;
}

function atomicWrite(p, dataStr) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, dataStr);
  fs.renameSync(tmp, p);
}

/** Restore config + registry from a bundle. Returns { ok, error }. */
function restoreBundle(bundle) {
  const err = validateBundle(bundle);
  if (err) return { ok: false, error: err };
  // Snapshot the CURRENT state before overwriting, so a bad restore is undoable.
  // If that snapshot can't be written, REFUSE to restore — never destroy the only
  // good copy on disk for the sake of an unverified bundle.
  const snap = writeSnapshot("pre-restore");
  if (!snap.ok) {
    return {
      ok: false,
      error: `refused to restore: could not write a pre-restore snapshot (${snap.error}). Nothing was changed.`,
    };
  }
  // Capture the live registry BEFORE overwriting anything (saveConfig only touches
  // config.json, so registry.json is still the current one here).
  const currentReg = readJson(REGISTRY_PATH, {});
  saveConfig(bundle.config);
  if (bundle.registry && typeof bundle.registry === "object") {
    // OPT-OUT ALWAYS WINS — even across a restore. Restoring an older bundle must
    // never resurrect a number that has since opted out. Merge so any number
    // withdrawn in EITHER the current registry or the bundle stays withdrawn.
    const merged = { ...bundle.registry };
    for (const [k, rec] of Object.entries(currentReg)) {
      if (rec && rec.status === "withdrawn") merged[k] = rec;
    }
    atomicWrite(REGISTRY_PATH, JSON.stringify(merged, null, 2));
  }
  return { ok: true, at: bundle.at, brokers: Object.keys(bundle.config.brokers || {}).length };
}

/** Write a timestamped on-disk snapshot and prune to the last KEEP. */
function writeSnapshot(tag) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `backup-${stamp}${tag ? "-" + tag : ""}.json`;
    atomicWrite(path.join(BACKUP_DIR, name), JSON.stringify(buildBundle(), null, 2));
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("backup-") && f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      } catch {
        /* ignore prune errors */
      }
    }
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listSnapshots() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("backup-") && f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** POST the bundle to an off-box URL the operator owns. Returns {ok, error}. */
async function pushOffbox(url) {
  if (!url) return { ok: false, error: "no backupWebhookUrl configured" };
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBundle()),
      timeoutMs: 15_000,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  buildBundle,
  restoreBundle,
  validateBundle,
  writeSnapshot,
  listSnapshots,
  pushOffbox,
  BACKUP_DIR,
  CONFIG_PATH,
  REGISTRY_PATH,
};
