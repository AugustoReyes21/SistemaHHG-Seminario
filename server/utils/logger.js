const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = process.env.LOG_FILE || 'app.log';
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024);
const MAX_FILES = Number(process.env.LOG_MAX_FILES || 5);

function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (_) {
    return '';
  }
}

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {}
}

function rotateIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat || stat.size < MAX_BYTES) return;
  } catch (_) {
    return;
  }
  for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, dst);
      } catch (_) {}
    }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (_) {}
}

function writeToFile(line) {
  try {
    ensureLogDir();
    const filePath = path.join(LOG_DIR, LOG_FILE);
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line + '\n');
  } catch (_) {}
}

function logInfo(message, meta = {}) {
  const line = `[INFO] ${new Date().toISOString()} - ${message}${formatMeta(meta)}`;
  console.info(line);
  writeToFile(line);
}

function logWarn(message, meta = {}) {
  const line = `[WARN] ${new Date().toISOString()} - ${message}${formatMeta(meta)}`;
  console.warn(line);
  writeToFile(line);
}

function logError(message, meta = {}, err = null) {
  const line = `[ERROR] ${new Date().toISOString()} - ${message}${formatMeta(meta)}`;
  console.error(line);
  writeToFile(line);
  if (err) {
    const stack = err.stack || err.toString();
    console.error(stack);
    writeToFile(stack);
  }
}

module.exports = {
  logInfo,
  logWarn,
  logError
};
