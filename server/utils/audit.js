const fs = require('fs');
const path = require('path');
const { getAuditContext } = require('./auditContext');

const auditDir = path.join(__dirname, '..', 'audit');
const auditFile = path.join(auditDir, 'audit-log.jsonl');

function logAuditEvent(event) {
  if (!event || typeof event !== 'object') return;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    const context = getAuditContext() || {};
    const payload = {
      ts: new Date().toISOString(),
      request_id: context.request_id || null,
      ip_address: context.ip_address || null,
      method: context.method || null,
      uri: context.uri || null,
      username: context.username || null,
      user_role: context.user_role || null,
      session_id: context.session_id || null,
      ...event
    };
    fs.appendFile(auditFile, `${JSON.stringify(payload)}\n`, () => {});
  } catch (_) {}
}

function readAuditEvents() {
  try {
    if (!fs.existsSync(auditFile)) return [];
    const raw = fs.readFileSync(auditFile, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  logAuditEvent,
  auditFile,
  readAuditEvents
};
