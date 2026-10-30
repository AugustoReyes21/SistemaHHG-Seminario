const nodemailer = require('nodemailer');
const config = require('./config');

async function sendMail({ to, subject, text, smtp }) {
  const cfg = smtp || config.smtp;
  if (!cfg.user || !cfg.pass) return false;
  const secure = Number(cfg.port) === 465;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: false }
  });
  try {
    await transporter.sendMail({
      from: cfg.from,
      to,
      subject,
      text
    });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { sendMail };
