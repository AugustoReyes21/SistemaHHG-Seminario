/**
 * Evidencia en la interfaz real (ventas.html): respuesta perdida + reintento.
 *
 * Requisitos: servidor corriendo en http://127.0.0.1:3000 con los datos de prueba
 * (scripts/cargar-datos.js) y Edge o Chrome instalado.
 *   npm i --no-save puppeteer-core@23
 *   node evidencias/ui-respuesta-perdida.js
 *
 * Qué hace: inicia sesión con el usuario cajero "demo", agrega un medicamento y cobra. La primera
 * respuesta de /api/register_sale se corta a propósito DESPUÉS de que el servidor
 * la procesó (como un corte de Wi-Fi). Luego cobra de nuevo y comprueba en la base
 * que solo existe una venta y que el stock bajó una sola vez.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { pool } = require('../server/db');

const BASE = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, 'capturas');
const PRODUCT = 'Amoxicilina 500mg';
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ventas = async () => (await pool.query('SELECT COUNT(*)::int AS c FROM ventas')).rows[0].c;
const stock = async () =>
  (
    await pool.query(
      'SELECT SUM(l.quantity)::int AS q FROM lots l JOIN productos p ON p.id = l.product_id WHERE p.nombre_comercial = $1',
      [PRODUCT]
    )
  ).rows[0].q;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const executablePath = BROWSERS.find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({ executablePath, headless: true, defaultViewport: { width: 1400, height: 950 } });
  const page = await browser.newPage();
  page.on('dialog', async (d) => {
    console.log(`  [alerta] ${d.message().replace(/\n/g, ' | ')}`);
    await d.accept();
  });

  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle2' });
  await page.type('#username', 'demo');
  await page.type('#password', 'Demo2026!');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#loginForm button')]);
  await page.goto(`${BASE}/ventas.html`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.evaluate((name) => {
    const card = [...document.querySelectorAll('#productosList .product')].find((x) => x.textContent.includes(name));
    card.querySelector('button[data-id]').click();
  }, PRODUCT);
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '01-ventas-inicial.png') });

  // Pausa la respuesta de register_sale: la primera se corta, la segunda pasa.
  const cdp = await page.target().createCDPSession();
  let n = 0;
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*register_sale*', requestStage: 'Response' }] });
  cdp.on('Fetch.requestPaused', async (ev) => {
    n += 1;
    const key = ev.request.headers['Idempotency-Key'];
    const replayed = (ev.responseHeaders || []).some((h) => h.name.toLowerCase() === 'idempotent-replayed');
    console.log(`  register_sale #${n}: HTTP ${ev.responseStatusCode}${replayed ? ' (repetida)' : ''}, llave ${key}`);
    if (n === 1) {
      console.log('  -> se corta la conexión antes de que el navegador reciba la respuesta');
      await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionReset' });
    } else {
      await cdp.send('Fetch.continueRequest', { requestId: ev.requestId });
    }
  });

  async function cobrar() {
    await page.click('#checkoutBtn');
    await page.waitForSelector('#checkoutReceiptName', { visible: true });
    await page.$eval('#checkoutReceiptName', (el) => (el.value = ''));
    await page.type('#checkoutReceiptName', 'Consumidor Final');
    await page.click('#checkoutModalConfirm');
    await sleep(2500);
  }

  console.log(`Antes:            ventas=${await ventas()}  stock=${await stock()}`);
  console.log('Cobro, intento 1:');
  await cobrar();
  console.log(`Tras intento 1:   ventas=${await ventas()}  stock=${await stock()}`);
  await page.screenshot({ path: path.join(OUT, '03-tras-corte.png') });
  console.log('Cobro, intento 2 (el cajero vuelve a presionar Cobrar):');
  await cobrar();
  console.log(`Tras intento 2:   ventas=${await ventas()}  stock=${await stock()}`);
  await page.screenshot({ path: path.join(OUT, '05-tras-reintento.png') });
  await browser.close();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
