/**
 * multitenant.js — isolation, login/session, and webhook-key routing for the
 * multi-tenant layer. Runs against a throwaway DATA_DIR so it never touches a
 * real install. Must be a SEPARATE node process from other DATA_DIR tests
 * (tenant.js caches DATA_DIR at require time).
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// Isolated data dir BEFORE requiring the app modules (they read DATA_DIR at load).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mt-"));
process.env.DATA_DIR = DATA_DIR;
process.env.SUPERADMIN_USER = "admin";
process.env.SUPERADMIN_PASS = "sup3rpass";

const tenant = require("../lib/tenant");
const store = require("../lib/store");
const verify = require("../lib/verify");

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

console.log("Multi-tenant:");

// 1. Fresh-deploy migration seeds ONLY the super-admin, idempotently.
tenant.migrateLegacyIfNeeded();
tenant.migrateLegacyIfNeeded();
let accts = tenant.listAccounts();
ok("fresh deploy seeds exactly one account", accts.length === 1);
ok("seeded account is the super-admin", accts[0].role === "super");
ok("listed accounts never expose a password hash", !("passwordHash" in accts[0]) && !("passwordSalt" in accts[0]));

// 2. Login.
ok("super logs in with the right password", !!tenant.verifyLogin("admin", "sup3rpass"));
ok("wrong password is rejected", tenant.verifyLogin("admin", "nope") === null);
ok("unknown user is rejected", tenant.verifyLogin("ghost", "x") === null);

// 3. Create two isolated user accounts.
tenant.createAccount({ username: "valor", label: "Valor", password: "pwValor", role: "user" });
tenant.createAccount({ username: "team2", label: "Team Two", password: "pwTeam2", role: "user" });
ok("creating a user seeds its tenant folder", fs.existsSync(path.join(DATA_DIR, "tenants", "valor", "config.json")));
let dup = false;
try {
  tenant.createAccount({ username: "valor", label: "x", password: "y" });
} catch {
  dup = true;
}
ok("duplicate username is rejected", dup);

// 4. Per-tenant config isolation.
tenant.runInTenant("valor", () =>
  store.saveConfig({ ...store.loadConfig(), webhookKey: "KEY_VALOR", master: { label: "m", locationId: "LOC_V", token: "TOK_V" } })
);
tenant.runInTenant("team2", () =>
  store.saveConfig({ ...store.loadConfig(), webhookKey: "KEY_TEAM2", master: { label: "m", locationId: "LOC_T", token: "TOK_T" } })
);
const vCfg = tenant.runInTenant("valor", () => store.loadConfig());
const tCfg = tenant.runInTenant("team2", () => store.loadConfig());
ok("valor sees only its own webhook key", vCfg.webhookKey === "KEY_VALOR");
ok("team2 sees only its own webhook key", tCfg.webhookKey === "KEY_TEAM2");
ok("valor master token isolated", vCfg.master.token === "TOK_V");
ok("team2 master token isolated", tCfg.master.token === "TOK_T");

// 5. Webhook-key routing.
ok("KEY_VALOR routes to valor", tenant.resolveTenantByWebhookKey("KEY_VALOR") === "valor");
ok("KEY_TEAM2 routes to team2", tenant.resolveTenantByWebhookKey("KEY_TEAM2") === "team2");
ok("unknown key routes nowhere", tenant.resolveTenantByWebhookKey("nope") === null);
ok("empty key routes nowhere", tenant.resolveTenantByWebhookKey("") === null);
ok("key taken by a different tenant", tenant.webhookKeyTaken("KEY_VALOR", "team2") === true);
ok("own key is not 'taken' against self", tenant.webhookKeyTaken("KEY_VALOR", "valor") === false);
ok("a free key is not taken", tenant.webhookKeyTaken("KEY_FREE", "valor") === false);

// 6. Registry (opt-in evidence) isolation.
tenant.runInTenant("valor", () => verify.registerVerification({ phone: "+15551230000", evidence: "attributionSource" }));
const vHas = tenant.runInTenant("valor", () => verify.isVerified("+15551230000"));
const tHas = tenant.runInTenant("team2", () => verify.isVerified("+15551230000"));
ok("valor sees its own verification", !!vHas);
ok("team2 does NOT see valor's verification", tHas === null);
// An opt-out in one tenant must not touch another tenant's registry.
tenant.runInTenant("team2", () => verify.withdrawVerification("+15551230000", "test"));
const vStill = tenant.runInTenant("valor", () => verify.isVerified("+15551230000"));
ok("valor's verification survives team2's opt-out (registries are isolated)", !!vStill);

// 7. Disabled tenant is not routable.
tenant.setDisabled("team2", true);
ok("disabled tenant drops out of webhook routing", tenant.resolveTenantByWebhookKey("KEY_TEAM2") === null);
tenant.setDisabled("team2", false);
ok("re-enabled tenant routes again", tenant.resolveTenantByWebhookKey("KEY_TEAM2") === "team2");

// 8. Cannot disable the super-admin.
let guarded = false;
try {
  tenant.setDisabled("super", true);
} catch {
  guarded = true;
}
ok("super-admin cannot be disabled", guarded);

// 9. Session sign/verify round-trip + tamper resistance.
const tok = tenant.signSession({ accountId: "super", activeTenant: null });
const payload = tenant.verifySession(tok);
ok("session round-trips accountId", payload && payload.accountId === "super");
ok("garbage token rejected", tenant.verifySession("garbage") === null);
ok("tampered token rejected", tenant.verifySession(tok.slice(0, -2) + (tok.slice(-2) === "AA" ? "BB" : "AA")) === null);
ok("empty token rejected", tenant.verifySession("") === null);

console.log(`\n${fail ? "✗" : "✓"} multi-tenant: ${pass} passed, ${fail} failed`);
try {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
