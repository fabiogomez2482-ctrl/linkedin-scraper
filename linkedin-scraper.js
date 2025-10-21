// linkedin-scraper.js
// 🚀 Versión FINAL: BrightData proxy obligatorio + Puppeteer-Stealth + Airtable + manejo cookies/login
// Variables de entorno obligatorias:
// PROXY_URL (recomendado)
// AIRTABLE_API_KEY, AIRTABLE_BASE_ID
// LINKEDIN_COOKIES o LINKEDIN_EMAIL + LINKEDIN_PASSWORD
// Ejemplo de PROXY_URL: http://brd-customer-hl_aede167c-zone-residential_proxy_scraper:0xtls13qh35l@brd.superproxy.io:33335

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { execSync } = require('child_process');
const fs = require('fs');
const Airtable = require('airtable');
const cron = require('node-cron');
const url = require('url');

puppeteer.use(StealthPlugin());

// -------------------- CONFIG --------------------
const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  LINKEDIN_EMAIL: process.env.LINKEDIN_EMAIL,
  LINKEDIN_PASSWORD: process.env.LINKEDIN_PASSWORD,
  PROXY_URL: process.env.PROXY_URL || null,
  PROXY_HOST: process.env.PROXY_HOST || null,
  PROXY_PORT: process.env.PROXY_PORT || null,
  PROXY_USER: process.env.PROXY_USER || null,
  PROXY_PASS: process.env.PROXY_PASS || null,
  ALLOW_MANUAL_LOGIN: (process.env.ALLOW_MANUAL_LOGIN || 'false').toLowerCase() === 'true',
  MANUAL_LOGIN_TIMEOUT_MS: Number(process.env.MANUAL_LOGIN_TIMEOUT_MS) || 120000,
  MAX_POSTS_PER_PROFILE: Number(process.env.MAX_POSTS_PER_PROFILE) || 10,
  DELAY_BETWEEN_PROFILES: Number(process.env.DELAY_BETWEEN_PROFILES) || 60000,
  PAGE_TIMEOUT: Number(process.env.PAGE_TIMEOUT) || 90000,
  COOKIE_WARNING_DAYS: Number(process.env.COOKIE_WARNING_DAYS) || 5,
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 */6 * * *' // cada 6 horas
};

// -------------------- PROXY BUILDER --------------------
function buildProxy() {
  if (CONFIG.PROXY_URL) {
    try {
      const parsed = url.parse(CONFIG.PROXY_URL);
      const auth = parsed.auth ? parsed.auth.split(':') : null;
      return {
        server: `${parsed.protocol}//${parsed.host}`,
        host: parsed.hostname,
        port: parsed.port,
        user: auth ? auth[0] : null,
        pass: auth ? auth[1] : null,
        full: CONFIG.PROXY_URL
      };
    } catch (e) {
      return { full: CONFIG.PROXY_URL };
    }
  }
  if (CONFIG.PROXY_HOST && CONFIG.PROXY_PORT) {
    const cred = (CONFIG.PROXY_USER && CONFIG.PROXY_PASS) ? `${CONFIG.PROXY_USER}:${CONFIG.PROXY_PASS}@` : '';
    return {
      server: `http://${cred}${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`,
      full: `http://${cred}${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`
    };
  }
  return null;
}

const PROXY = buildProxy();
if (!PROXY || !PROXY.full) {
  console.error('❌ PROXY obligatorio no configurado. Define PROXY_URL o PROXY_HOST/PORT + PROXY_USER/PROXY_PASS');
  process.exit(1);
}

// -------------------- Airtable init --------------------
let base = null;
if (CONFIG.AIRTABLE_API_KEY && CONFIG.AIRTABLE_BASE_ID) {
  base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);
}

// -------------------- Helpers --------------------
const delay = ms => new Promise(res => setTimeout(res, ms));
const log = (msg, type = 'info') => {
  const ts = new Date().toISOString();
  const pfx = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${pfx} [${ts}] ${msg}`);
};

function findChromePath() {
  const possible = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium'];
  for (const p of possible) if (fs.existsSync(p)) return p;
  try {
    const found = execSync('find / -name chrome -type f 2>/dev/null | head -n 1').toString().trim();
    if (found) return found;
  } catch {}
  return undefined;
}

// -------------------- Cookies --------------------
function loadCookies() {
  try {
    if (process.env.LINKEDIN_COOKIES) {
      const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
      if (Array.isArray(cookies)) return cookies;
    }
    if (fs.existsSync('./cookies.json')) {
      const cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
      if (Array.isArray(cookies)) return cookies;
    }
  } catch {}
  return null;
}

async function saveCookies(cookies) {
  try {
    fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));
    log('✅ Cookies guardadas en cookies.json', 'success');
  } catch (e) {
    log(`⚠️ Error guardando cookies: ${e.message}`, 'warning');
  }
}

// -------------------- Login --------------------
async function loginLinkedIn(page) {
  const cookies = loadCookies();
  if (cookies) {
    await page.setCookie(...cookies);
    await page.goto('https://www.linkedin.com/feed', { waitUntil: 'networkidle2' });
    const ok = await page.$('nav.global-nav');
    if (ok) return true;
  }

  log('🔐 Intentando login manual/automático...');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2' });

  if (CONFIG.LINKEDIN_EMAIL && CONFIG.LINKEDIN_PASSWORD) {
    await page.type('#username', CONFIG.LINKEDIN_EMAIL, { delay: 60 });
    await page.type('#password', CONFIG.LINKEDIN_PASSWORD, { delay: 60 });
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);
    const logged = await page.$('nav.global-nav');
    if (logged) {
      const cookies = await page.cookies();
      await saveCookies(cookies);
      return true;
    }
  }
  return false;
}

// -------------------- Scraping placeholder --------------------
async function scrapeProfilePosts(page, profileUrl, name) {
  log(`📊 Extrayendo publicaciones de ${name}...`);
  await page.goto(profileUrl, { waitUntil: 'networkidle2' });
  await delay(3000);
  return 0; // cambiar por la lógica real
}

// -------------------- RUN --------------------
async function runScraperOnce() {
  log('🚀 Iniciando scraper con BrightData proxy...');
  let browser;
  try {
    const chromePath = findChromePath();
    const browserArgs = [
      `--proxy-server=${PROXY.server}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080'
    ];

    log(`🌐 Proxy en uso: ${PROXY.server.replace(/:\/\/.*@/, '://***@')}`);

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: chromePath,
      args: browserArgs
    });

    const page = await browser.newPage();
    if (PROXY.user && PROXY.pass) {
      await page.authenticate({ username: PROXY.user, password: PROXY.pass });
      log('🔐 Autenticación de proxy aplicada', 'success');
    }

    // Verificar IP
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2' });
    const ip = await page.evaluate(() => document.body.innerText);
    log(`🌍 IP detectada: ${ip}`);

    // Login
    const logged = await loginLinkedIn(page);
    if (!logged) throw new Error('No se pudo iniciar sesión en LinkedIn.');

    // Obtener perfiles desde Airtable
    let profiles = [];
    if (base) {
      const records = await base('Sources').select({ filterByFormula: '{Status}="Active"' }).all();
      profiles = records.map(r => ({
        id: r.id,
        name: r.get('Name'),
        profileUrl: r.get('Profile URL')
      }));
      log(`📋 ${profiles.length} perfiles encontrados en Airtable`);
    }

    for (const p of profiles) {
      await scrapeProfilePosts(page, p.profileUrl, p.name);
      await delay(CONFIG.DELAY_BETWEEN_PROFILES);
    }

    log('✅ Scraper finalizado correctamente', 'success');
  } catch (err) {
    log(`❌ Error en runScraperOnce: ${err.message}`, 'error');
  } finally {
    if (browser) await browser.close();
  }
}

// -------------------- CRON --------------------
log('🧠 Scraper iniciado (BrightData + LinkedIn + Airtable)');
log(`🕒 Ejecutando cada: ${CONFIG.CRON_SCHEDULE}`);
runScraperOnce();
cron.schedule(CONFIG.CRON_SCHEDULE, runScraperOnce);
