/**
 * LinkedIn Scraper — versión corregida (21 Oct 2025)
 * Autor: Bryan + GPT-5
 */

const puppeteer = require('puppeteer');
import Airtable from 'airtable';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// ====================== CONFIGURACIONES ======================
const {
  LINKEDIN_COOKIES,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME,
  PORT = 3000
} = process.env;

// ====================== LOGGING CON COLORES ======================
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(msg, type = 'info') {
  const color =
    type === 'error' ? colors.red :
    type === 'warn' ? colors.yellow :
    type === 'success' ? colors.green :
    colors.cyan;
  console.log(`${color}[${new Date().toISOString()}] ${msg}${colors.reset}`);
}

// ====================== CHEQUEO DE VARIABLES ======================
if (!LINKEDIN_COOKIES) {
  log('⚠️ Falta LINKEDIN_COOKIES. El servicio se mantendrá vivo.', 'warn');
}
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
  log('⚠️ Configura las variables de Airtable antes de usar el scraper.', 'warn');
}

// ====================== FUNCIONES AUXILIARES ======================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkCookieExpiration(cookies) {
  const liAt = cookies.find((c) => c.name === 'li_at');
  if (!liAt) return 'NO_LI_AT_COOKIE';

  const expRaw = liAt.expires || liAt.expiry || liAt.expirationDate;
  if (!expRaw) return 'NO_EXPIRY_DATE';

  let expiryDate;
  if (expRaw > 1e12) expiryDate = new Date(expRaw); // ms
  else expiryDate = new Date(expRaw * 1000); // s

  const daysLeft = Math.round((expiryDate - Date.now()) / (1000 * 60 * 60 * 24));
  return daysLeft < 0 ? 'EXPIRED' : `VALID_${daysLeft}_DAYS_LEFT`;
}

async function checkIfLoggedIn(page) {
  try {
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await page.waitForSelector('[data-test-global-nav-link="feed"]', { timeout: 5000 });
    log('✅ Login exitoso en LinkedIn', 'success');
    return true;
  } catch {
    log('❌ No se detectó sesión activa', 'error');
    return false;
  }
}

async function findChromePath() {
  const possible = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chrome'
  ];
  for (const p of possible) {
    try {
      const fs = await import('fs');
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// ====================== SCRAPER PRINCIPAL ======================
async function runScraper() {
  log('🚀 Iniciando proceso de scraping...');

  const cookies = LINKEDIN_COOKIES ? JSON.parse(LINKEDIN_COOKIES) : [];
  log(`🔐 Cookies cargadas: ${cookies.length} items`);

  const status = checkCookieExpiration(cookies);
  log(`📅 Estado de cookie li_at: ${status}`);

  const chromePath = await findChromePath();
  log(`🧭 Ejecutable Chrome: ${chromePath || 'default de Puppeteer'}`);

  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-notifications'
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: null,
    dumpio: true
  };
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();

  // Interceptar solo imágenes/medios
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  // Aplicar cookies
  try {
    await page.setCookie(...cookies);
  } catch (err) {
    log(`⚠️ Error aplicando cookies: ${err.message}`, 'warn');
  }

  const loggedIn = await checkIfLoggedIn(page);
  if (!loggedIn) {
    log('❌ No se pudo iniciar sesión. Revisa LINKEDIN_COOKIES.', 'error');
    await browser.close();
    return { success: false, reason: 'LOGIN_FAILED' };
  }

  // Aquí tu lógica real de scraping o Airtable update
  log('🧠 Simulando scraping de publicaciones recientes...');
  await sleep(5000);

  log('📤 (Demo) Publicaciones actualizadas en Airtable.');
  await browser.close();
  return { success: true };
}

// ====================== SERVIDOR EXPRESS ======================
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/scrape-on-demand', async (req, res) => {
  log('📬 Petición recibida en /scrape-on-demand');
  try {
    const result = await runScraper();
    res.json({ ok: result.success, result });
  } catch (e) {
    log(`❌ Error en ejecución manual: ${e.message}`, 'error');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================== INICIO DEL SERVICIO ======================
app.listen(PORT, () => log(`🚦 Servidor Express activo en puerto ${PORT}`));

// Ejecución automática por CRON (Railway Scheduler o node-cron)
if (process.env.RUN_SCRAPER_ON_START === 'true') {
  runScraper().catch((e) => log(`❌ Error al ejecutar scraping automático: ${e.message}`, 'error'));
}
