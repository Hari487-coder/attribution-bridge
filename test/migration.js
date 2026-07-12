/**
 * migration.js — the one-time legacy → tenants/valor migration. Proves an
 * existing single-tenant install (Anthony's live instance) is preserved intact
 * and turned into the "Valor" account, and that re-running is a no-op.
 * Separate node process from multitenant.js (DATA_DIR is cached at require time).
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ab-legacy-"));
process.env.DATA_DIR = DATA_DIR;
process.env.SUPERADMIN_USER = "admin";
delete process.env.SUPERADMIN_PASS; // exercise the generated-password path

// Simulate a pre-multi-tenant install: single config/registry/activity at root.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  path.join(DATA_DIR, "config.json"),
  JSON.stringify(
    {
      webhookKey: "LEGACY_KEY",
      adminPassword: "legacy-admin-pw-PLACEHOLDER",
      master: { locationId: "LOC", token: "TOK", label: "Master" },
      brokers: { alpha: { label: "Alpha", locationId: "LA", token: "TA" } },
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(DATA_DIR, "registry.json"),
  JSON.stringify({ "+15550001111": { phone: "+15550001111", status: "active", evidence: "attributionSource" } }, null, 2)
);
fs.writeFileSync(path.join(DATA_DIR, "activity.jsonl"), JSON.stringify({ at: "2026-01-01T00:00:00Z", kind: "distribute", ok: true }) + "\n");

const tenant = require("../lib/tenant");
const store = require("../lib/store");

let pass = 0,
  fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name);
  }
}

console.log("Legacy migration:");
tenant.migrateLegacyIfNeeded();

ok("legacy config.json moved out of the data root", !fs.existsSync(path.join(DATA_DIR, "config.json")));
ok("config.json now lives under tenants/valor", fs.existsSync(path.join(DATA_DIR, "tenants", "valor", "config.json")));
ok("registry.json moved to valor", fs.existsSync(path.join(DATA_DIR, "tenants", "valor", "registry.json")));
ok("activity.jsonl moved to valor", fs.existsSync(path.join(DATA_DIR, "tenants", "valor", "activity.jsonl")));

const accts = tenant.listAccounts();
ok("two accounts seeded (super + valor)", accts.length === 2);
ok("valor is a user account", accts.some((a) => a.id === "valor" && a.role === "user"));
ok("a super-admin exists", accts.some((a) => a.role === "super"));
ok("valor logs in with the migrated adminPassword", !!tenant.verifyLogin("valor", "legacy-admin-pw-PLACEHOLDER"));

const cfg = tenant.runInTenant("valor", () => store.loadConfig());
ok("valor keeps its webhook key", cfg.webhookKey === "LEGACY_KEY");
ok("valor keeps its master token", cfg.master.token === "TOK");
ok("valor keeps its broker + token", cfg.brokers.alpha && cfg.brokers.alpha.token === "TA");
ok("legacy webhook key still routes (to valor)", tenant.resolveTenantByWebhookKey("LEGACY_KEY") === "valor");

// Idempotent: a second run changes nothing.
tenant.migrateLegacyIfNeeded();
ok("second migrate is a no-op (still 2 accounts)", tenant.listAccounts().length === 2);
ok("valor config still intact after re-migrate", tenant.runInTenant("valor", () => store.loadConfig()).master.token === "TOK");

console.log(`\n${fail ? "✗" : "✓"} legacy migration: ${pass} passed, ${fail} failed`);
try {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
