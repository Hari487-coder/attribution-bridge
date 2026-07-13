/**
 * tenant.js — multi-tenant foundation. Zero new dependencies (Node built-ins only).
 *
 *  - Per-request tenant context via AsyncLocalStorage: every store/verify/backup
 *    read+write resolves its files from the CURRENT tenant's folder. Outside a
 *    context (tests, one-off scripts) it falls back to the legacy single DATA_DIR,
 *    so pre-multi-tenant call sites keep working unchanged.
 *  - Accounts store (accounts.json): logins, scrypt password hashes, roles.
 *  - Signed session cookies (HMAC) — no server-side session store.
 *  - Webhook-key → tenant routing (preserves existing GHL webhooks).
 *  - One-time legacy → tenants/valor migration + super-admin seed.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ACCOUNTS_PATH = path.join(DATA_DIR, "accounts.json");
const TENANTS_DIR = path.join(DATA_DIR, "tenants");

const als = new AsyncLocalStorage();

// ── tenant context ───────────────────────────────────────────────────────────
function tenantDir(tenantId) {
  return path.join(TENANTS_DIR, tenantId);
}
/** Run fn with `tenantId` as the active tenant for all nested store/verify calls. */
function runInTenant(tenantId, fn) {
  return als.run({ tenantId, dir: tenantDir(tenantId) }, fn);
}
/** The active tenant's data dir, or the legacy DATA_DIR when outside a context. */
function currentTenantDir() {
  return als.getStore()?.dir ?? DATA_DIR;
}
function currentTenantId() {
  return als.getStore()?.tenantId ?? null;
}

// Per-tenant file paths (single source of truth for every data module).
function configPath() {
  return path.join(currentTenantDir(), "config.json");
}
function logPath() {
  return path.join(currentTenantDir(), "activity.jsonl");
}
function registryPath() {
  return path.join(currentTenantDir(), "registry.json");
}
function schedulerPath() {
  return path.join(currentTenantDir(), "scheduler.json");
}
function backupDir() {
  return path.join(currentTenantDir(), "backups");
}
function idempotencyPath() {
  return path.join(currentTenantDir(), "idempotency.json");
}

// ── accounts store ───────────────────────────────────────────────────────────
function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
  } catch {
    return { sessionSecret: "", accounts: {} };
  }
}
function saveAccounts(a) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
  fs.renameSync(tmp, ACCOUNTS_PATH);
}
function sessionSecret() {
  const a = loadAccounts();
  if (a.sessionSecret) return a.sessionSecret;
  a.sessionSecret = crypto.randomBytes(32).toString("hex");
  saveAccounts(a);
  return a.sessionSecret;
}

// ── passwords (scrypt) ───────────────────────────────────────────────────────
function hashPassword(pw) {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(String(pw), passwordSalt, 64).toString("hex");
  return { passwordSalt, passwordHash };
}
function verifyPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(String(pw), salt, 64);
  const stored = Buffer.from(hash, "hex");
  return computed.length === stored.length && crypto.timingSafeEqual(computed, stored);
}

// ── sessions (HMAC-signed cookie value) ──────────────────────────────────────
const SESSION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
function signSession(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs() + SESSION_MAX_AGE_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && nowMs() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
// new Date()/Date.now() are fine here (runtime, not a workflow script).
function nowMs() {
  return Date.now();
}

// ── account CRUD ─────────────────────────────────────────────────────────────
function redactAccount(acct) {
  if (!acct) return null;
  const { passwordHash, passwordSalt, ...rest } = acct;
  return rest;
}
function listAccounts() {
  return Object.values(loadAccounts().accounts).map(redactAccount);
}
function getAccount(id) {
  return loadAccounts().accounts[id] ?? null;
}
function findByUsername(username) {
  const u = String(username).trim().toLowerCase();
  return Object.values(loadAccounts().accounts).find((x) => x.username.toLowerCase() === u) ?? null;
}
function verifyLogin(username, password) {
  const acct = findByUsername(username);
  if (!acct || acct.disabled) return null;
  if (!verifyPassword(password, acct.passwordSalt, acct.passwordHash)) return null;
  return acct;
}
function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function createAccount({ id, username, label, password, role = "user" }) {
  const a = loadAccounts();
  const accountId = slugify(id || username || label);
  if (!accountId) throw new Error("account id/username required");
  if (a.accounts[accountId]) throw new Error(`account "${accountId}" already exists`);
  const uname = String(username || accountId).trim();
  if (Object.values(a.accounts).some((x) => x.username.toLowerCase() === uname.toLowerCase())) {
    throw new Error(`username "${uname}" is taken`);
  }
  if (!password) throw new Error("password required");
  const { passwordSalt, passwordHash } = hashPassword(password);
  a.accounts[accountId] = {
    id: accountId,
    username: uname,
    label: label || uname,
    role: role === "super" ? "super" : "user",
    passwordHash,
    passwordSalt,
    tenantId: role === "super" ? null : accountId,
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  saveAccounts(a);
  if (role !== "super") ensureTenantSeed(accountId);
  return a.accounts[accountId];
}
function setPassword(id, password) {
  const a = loadAccounts();
  if (!a.accounts[id]) throw new Error("no such account");
  if (!password) throw new Error("password required");
  Object.assign(a.accounts[id], hashPassword(password));
  saveAccounts(a);
}
function setDisabled(id, disabled) {
  const a = loadAccounts();
  if (!a.accounts[id]) throw new Error("no such account");
  if (a.accounts[id].role === "super" && disabled) throw new Error("cannot disable the super-admin");
  a.accounts[id].disabled = !!disabled;
  saveAccounts(a);
}

/** Create a tenant folder with an empty config (store.loadConfig fills defaults). */
function ensureTenantSeed(tenantId) {
  const dir = tenantDir(tenantId);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "config.json");
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({}, null, 2));
}

// ── webhook-key → tenant ─────────────────────────────────────────────────────
/** Find the (enabled) tenant whose config.webhookKey matches. Null if none. */
function resolveTenantByWebhookKey(key) {
  if (!key) return null;
  for (const acct of Object.values(loadAccounts().accounts)) {
    if (acct.disabled || !acct.tenantId) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(tenantDir(acct.tenantId), "config.json"), "utf8"));
      if (cfg.webhookKey && cfg.webhookKey === key) return acct.tenantId;
    } catch {
      /* skip unreadable */
    }
  }
  return null;
}
/**
 * True if `key` is already used by a DIFFERENT tenant (for uniqueness on save).
 * Unlike resolveTenantByWebhookKey (routing), this counts DISABLED tenants too —
 * otherwise a disabled tenant's key would look free, get reused, and then collide
 * and mis-route (into the wrong tenant's opt-out registry) if it is re-enabled.
 */
function webhookKeyTaken(key, exceptTenantId) {
  if (!key) return false;
  for (const acct of Object.values(loadAccounts().accounts)) {
    if (!acct.tenantId || acct.tenantId === exceptTenantId) continue; // skip super + self
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(tenantDir(acct.tenantId), "config.json"), "utf8"));
      if (cfg.webhookKey && cfg.webhookKey === key) return true;
    } catch {
      /* skip unreadable */
    }
  }
  return false;
}

// ── one-time legacy migration + seed ─────────────────────────────────────────
function migrateLegacyIfNeeded() {
  fs.mkdirSync(TENANTS_DIR, { recursive: true });

  // 1. Move a legacy single-tenant layout into tenants/valor/.
  const legacyConfig = path.join(DATA_DIR, "config.json");
  const valorDir = tenantDir("valor");
  if (fs.existsSync(legacyConfig) && !fs.existsSync(valorDir)) {
    fs.mkdirSync(valorDir, { recursive: true });
    for (const f of ["config.json", "registry.json", "activity.jsonl", "scheduler.json"]) {
      const src = path.join(DATA_DIR, f);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(valorDir, f));
    }
    const legacyBackups = path.join(DATA_DIR, "backups");
    if (fs.existsSync(legacyBackups) && !fs.existsSync(path.join(valorDir, "backups"))) {
      fs.renameSync(legacyBackups, path.join(valorDir, "backups"));
    }
  }

  // 2. Seed accounts.json on first boot (super-admin + valor if it exists).
  const a = loadAccounts();
  if (Object.keys(a.accounts).length === 0) {
    const suUser = process.env.SUPERADMIN_USER || "admin";
    const suPass = process.env.SUPERADMIN_PASS || crypto.randomBytes(6).toString("hex");
    createAccount({ id: "super", username: suUser, label: "Super Admin", password: suPass, role: "super" });
    if (fs.existsSync(valorDir)) {
      let valorPass = process.env.VALOR_PASS || "";
      if (!valorPass) {
        try {
          valorPass = JSON.parse(fs.readFileSync(path.join(valorDir, "config.json"), "utf8")).adminPassword || "";
        } catch {
          /* ignore */
        }
      }
      createAccount({ id: "valor", username: "valor", label: "Valor", password: valorPass || crypto.randomBytes(6).toString("hex"), role: "user" });
    }
    if (!process.env.SUPERADMIN_PASS) {
      // First-boot bootstrap: surface the generated password once in the logs.
      console.log(`[tenant] seeded super-admin username="${suUser}" password="${suPass}" (set SUPERADMIN_USER/PASS to control this)`);
    }
  }

  // 3. Reconcile the super-admin from env on EVERY boot (idempotent). The seed
  // above only runs on a fresh disk, so if SUPERADMIN_USER/PASS are set AFTER the
  // first boot (when a random password was seeded), the login page would silently
  // keep the old credentials. This makes the env vars authoritative regardless of
  // boot order. Runs only when SUPERADMIN_PASS is explicitly set (no env pass =>
  // keep whatever is on disk). Writes only when something actually differs, so it
  // never rewrites the hash or fights an in-app change unnecessarily.
  if (process.env.SUPERADMIN_PASS) {
    const accts = loadAccounts();
    const su = accts.accounts.super;
    if (su) {
      let changed = false;
      const desiredUser = (process.env.SUPERADMIN_USER || su.username).trim();
      if (desiredUser && desiredUser.toLowerCase() !== su.username.toLowerCase()) {
        const clash = Object.values(accts.accounts).some(
          (x) => x.id !== "super" && x.username.toLowerCase() === desiredUser.toLowerCase()
        );
        if (clash) {
          console.log(`[tenant] SUPERADMIN_USER="${desiredUser}" is taken by another account; keeping "${su.username}"`);
        } else {
          su.username = desiredUser;
          changed = true;
        }
      }
      if (!verifyPassword(process.env.SUPERADMIN_PASS, su.passwordSalt, su.passwordHash)) {
        Object.assign(su, hashPassword(process.env.SUPERADMIN_PASS));
        changed = true;
        console.log("[tenant] reconciled super-admin password from SUPERADMIN_PASS");
      }
      if (changed) saveAccounts(accts);
    }
  }
}

module.exports = {
  DATA_DIR,
  TENANTS_DIR,
  tenantDir,
  runInTenant,
  currentTenantDir,
  currentTenantId,
  configPath,
  logPath,
  registryPath,
  schedulerPath,
  backupDir,
  idempotencyPath,
  loadAccounts,
  saveAccounts,
  listAccounts,
  getAccount,
  findByUsername,
  verifyLogin,
  createAccount,
  setPassword,
  setDisabled,
  ensureTenantSeed,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  resolveTenantByWebhookKey,
  webhookKeyTaken,
  migrateLegacyIfNeeded,
};
