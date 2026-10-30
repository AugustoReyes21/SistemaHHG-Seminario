require('dotenv').config();

const detectedTimezone = (() => {
  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (_) {
      return null;
    }
  }
  return null;
})();
process.env.TZ = process.env.TZ || detectedTimezone || 'UTC';

const fs = require('fs');
const http = require('http');
const https = require('https');
const config = require('./config');
const { createApp } = require('./app');
const { ensureDatabaseReady } = require('./utils/dbMaintenance');

const app = createApp();

async function start() {
  await ensureDatabaseReady();
  const host = process.env.HOST || '0.0.0.0';
  const pfxPath = process.env.SSL_PFX_PATH ? String(process.env.SSL_PFX_PATH).trim() : '';
  const pfxPassphrase = process.env.SSL_PFX_PASSPHRASE
    ? String(process.env.SSL_PFX_PASSPHRASE)
    : '';
  const keyPath = process.env.SSL_KEY_PATH ? String(process.env.SSL_KEY_PATH).trim() : '';
  const certPath = process.env.SSL_CERT_PATH ? String(process.env.SSL_CERT_PATH).trim() : '';
  const caPath = process.env.SSL_CA_PATH ? String(process.env.SSL_CA_PATH).trim() : '';
  const hasPfx = pfxPath && fs.existsSync(pfxPath);
  const hasTls = keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath);

  if (hasPfx || hasTls) {
    const tlsOpts = hasPfx
      ? {
          pfx: fs.readFileSync(pfxPath)
        }
      : {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath)
        };
    if (hasPfx && pfxPassphrase) {
      tlsOpts.passphrase = pfxPassphrase;
    } else if (caPath && fs.existsSync(caPath)) {
      tlsOpts.ca = fs.readFileSync(caPath);
    }
    https.createServer(tlsOpts, app).listen(config.app.port, host, () => {
      console.log(`POS server running on https://${host}:${config.app.port}`);
    });
    if (process.env.HTTP_REDIRECT !== 'false') {
      const httpPort = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : 80;
      http
        .createServer((req, res) => {
          const hostHeader = req.headers.host || '';
          const hostOnly = hostHeader.split(':')[0];
          const target = `https://${hostOnly}:${config.app.port}${req.url}`;
          res.writeHead(301, { Location: target });
          res.end();
        })
        .listen(httpPort, host, () => {
          console.log(`HTTP redirect server on http://${host}:${httpPort}`);
        });
    }
  } else {
    app.listen(config.app.port, host, () => {
      console.log(`POS server running on http://${host}:${config.app.port}`);
    });
  }
}

start().catch((err) => {
  console.log('No se pudo iniciar el servidor:', err?.message || err);
  process.exit(1);
});
