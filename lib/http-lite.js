/** Minimal fetch wrapper with a timeout, for outbound webhook posts. */
async function fetchWithTimeout(url, { method = "POST", headers, body, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
