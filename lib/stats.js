/**
 * stats.js — fold the activity log into a per-broker funnel summary. Pure
 * aggregation of lines already written by the distribute pipeline; no new
 * logging needed. Used by GET /api/stats and the daily digest.
 */

const fs = require("node:fs");
const { LOG_PATH } = require("./store");

function classify(e) {
  if (e.refused) return "refused";
  if (e.skipped) return "skipped";
  if (e.ok === false || e.error) return "error";
  return "bridged";
}

/**
 * Summarize distribute outcomes since `sinceIso` (ISO string, optional).
 * Returns totals, per-broker breakdown, refusal-reason histogram, and the
 * timestamp of the most recent activity of any kind.
 */
function summarize({ sinceIso = null } = {}) {
  const totals = { received: 0, bridged: 0, refused: 0, skipped: 0, error: 0 };
  const perBroker = {};
  const refusalReasons = {};
  let lastActivityAt = null;
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
  } catch {
    return { totals, perBroker, refusalReasons, lastActivityAt, sinceIso };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.at && (!lastActivityAt || e.at > lastActivityAt)) lastActivityAt = e.at;
    if (sinceIso && e.at && e.at < sinceIso) continue;
    if (e.kind !== "distribute") continue;
    const cls = classify(e);
    totals.received += 1;
    totals[cls] += 1;
    const bk = e.brokerKey || "(unrouted)";
    perBroker[bk] = perBroker[bk] || { received: 0, bridged: 0, refused: 0, skipped: 0, error: 0 };
    perBroker[bk].received += 1;
    perBroker[bk][cls] += 1;
    if (cls === "refused" || cls === "error") {
      const r = (e.reason || e.error || "unknown").slice(0, 80);
      refusalReasons[r] = (refusalReasons[r] || 0) + 1;
    }
  }
  return { totals, perBroker, refusalReasons, lastActivityAt, sinceIso };
}

/**
 * Timestamp of the most recent activity, read from the TAIL of the log only.
 * The activity log is append-only and can embed full contact objects (migration
 * backups), so it grows large; /healthz is probed frequently and must not read
 * or parse the whole file. Read the last ~64KB and take the last complete line.
 */
function lastActivityAt() {
  try {
    const size = fs.statSync(LOG_PATH).size;
    if (!size) return null;
    const readBytes = Math.min(size, 65536);
    const fd = fs.openSync(LOG_PATH, "r");
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, size - readBytes);
      // The first line in the window may be truncated; iterate from the end and
      // return the first line that parses with an `at`.
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l) continue;
        try {
          const e = JSON.parse(l);
          if (e && e.at) return e.at;
        } catch {
          /* truncated leading line — skip */
        }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Count distribute events with an error/refusal newer than `sinceIso`. */
function countRecentFailures(sinceIso) {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
  } catch {
    return { errors: 0, samples: [] };
  }
  let errors = 0;
  const samples = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.at || (sinceIso && e.at <= sinceIso)) continue;
    if (e.kind === "distribute" && (e.ok === false || e.error) && !e.refused && !e.skipped) {
      errors += 1;
      if (samples.length < 5) samples.push({ brokerKey: e.brokerKey, contactId: e.masterContactId || e.contactId, error: e.error || e.reason });
    }
  }
  return { errors, samples };
}

module.exports = { summarize, countRecentFailures, lastActivityAt };
