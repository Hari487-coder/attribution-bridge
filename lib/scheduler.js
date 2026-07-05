/**
 * scheduler.js — one in-process interval that provides the "someone is watching"
 * layer the operator asked for:
 *   - periodic failure alerts (new distribute errors since last check)
 *   - a once-a-day digest (funnel summary) that doubles as a heartbeat —
 *     if it stops arriving, the bridge is down
 *   - a once-a-day on-disk snapshot + optional off-box backup push
 *
 * All outbound posts go to operator-owned webhook URLs (settings.alertWebhookUrl
 * / settings.backupWebhookUrl), typically a GHL inbound webhook that emails/SMSes
 * them. State is persisted so a restart doesn't double-send within a day.
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, DATA_DIR } = require("./store");
const stats = require("./stats");
const backup = require("./backup");
const { fetchWithTimeout } = require("./http-lite");
const { getLogger } = require("./logger-lite");

const STATE_PATH = path.join(DATA_DIR, "scheduler.json");
const TICK_MS = 5 * 60 * 1000; // 5 minutes

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastDigestDate: null, lastErrorAlertIso: null };
  }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

async function post(url, payload) {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function sendDigest(url) {
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const s = stats.summarize({ sinceIso });
  const topRefusals = Object.entries(s.refusalReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  await post(url, {
    type: "digest",
    at: new Date().toISOString(),
    period: "last 24h",
    totals: s.totals,
    perBroker: s.perBroker,
    topRefusals,
    lastActivityAt: s.lastActivityAt,
  });
}

/** Run one scheduler tick. Exposed for tests. */
async function tick() {
  const log = getLogger();
  const cfg = loadConfig();
  const settings = cfg.settings || {};
  const state = loadState();
  const now = new Date();

  // 1. Failure alerts — anything new since the last check.
  if (settings.alertWebhookUrl) {
    const since = state.lastErrorAlertIso;
    const { errors, samples } = stats.countRecentFailures(since);
    if (errors > 0) {
      try {
        await post(settings.alertWebhookUrl, {
          type: "alert",
          at: now.toISOString(),
          subject: `Attribution Bridge: ${errors} lead(s) failed to bridge`,
          errors,
          samples,
        });
      } catch (e) {
        log?.warn?.({ err: e.message }, "scheduler: alert post failed");
      }
    }
    // Advance the watermark regardless, so we don't re-alert the same errors.
    state.lastErrorAlertIso = now.toISOString();
    saveState(state);
  }

  // 2. Daily digest + backup — once per day at/after the configured hour (UTC).
  const digestHour = Number.isFinite(Number(settings.digestHourUtc)) ? Number(settings.digestHourUtc) : 13;
  const todayStr = now.toISOString().slice(0, 10);
  if (state.lastDigestDate !== todayStr && now.getUTCHours() >= digestHour) {
    // Snapshot first (cheap, on-disk) then optional off-box push.
    backup.writeSnapshot("daily");
    if (settings.backupWebhookUrl) {
      const r = await backup.pushOffbox(settings.backupWebhookUrl);
      if (!r.ok) log?.warn?.({ err: r.error }, "scheduler: off-box backup push failed");
    }
    if (settings.alertWebhookUrl) {
      try {
        await sendDigest(settings.alertWebhookUrl);
      } catch (e) {
        log?.warn?.({ err: e.message }, "scheduler: digest post failed");
      }
    }
    state.lastDigestDate = todayStr;
    saveState(state);
  }
}

let handle = null;
function start() {
  if (handle) return;
  // First tick shortly after boot, then on the interval. Never let a tick crash the process.
  const safeTick = () => tick().catch(() => {});
  setTimeout(safeTick, 20_000);
  handle = setInterval(safeTick, TICK_MS);
  if (handle.unref) handle.unref();
}

module.exports = { start, tick, sendDigest };
