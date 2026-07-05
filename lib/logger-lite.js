/** Tiny console logger. On Render, stdout/stderr land in the service logs. */
const logger = {
  info: (obj, msg) => console.log(msg || "", obj ? JSON.stringify(obj) : ""),
  warn: (obj, msg) => console.warn(msg || "", obj ? JSON.stringify(obj) : ""),
  error: (obj, msg) => console.error(msg || "", obj ? JSON.stringify(obj) : ""),
};

function getLogger() {
  return logger;
}

module.exports = { getLogger };
