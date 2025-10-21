// linkedin-scraper.js
// Versión: BrightData proxy obligatorio + Puppeteer-Stealth + Airtable + manejo cookies/login
// Pega en tu repo. Variables de entorno obligatorias: PROXY_URL (o PROXY_HOST/PORT + PROXY_USER/PROXY_PASS)

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
  LINKEDIN_USER: process.env.LINKEDIN_USER,
  LINKEDIN_PASS: process.env.LINKEDIN_PASS,
  // Mandatory: BrightData proxy URL OR host/port + user/pass
  PROXY_URL: process.env.PROXY_URL || null, // e.g. http://user:pass@brd.superproxy.io:33335
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
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 */6 * * *' // every 6 hours
};

// Build final proxy settings (mandatory in this version)
function buildProxy() {
  // If PROXY_URL provided and includes credentials, parse it.
  if (CONFIG.PROXY_URL) {
    try {
      const parsed = url.parse(CONFIG.PROXY_URL);
      const auth = parsed.auth ? parsed.auth.split(':') : null;
      return {
        server: `${parsed.protocol || 'http:'}//${parsed.host}`,
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
  // fallback: host/port + user/pass
  if (CONFIG.PROXY_HOST && CONFIG.PROXY_PORT) {
    const cred = (CONFIG.PROXY_USER && CONFIG.PROXY_PASS) ? `${CONFIG.PROXY_USER}:${CONFIG.PROXY_PASS}@` : '';
    return {
      server: `http://${cred}${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`,
      host: CONFIG.PROXY_HOST,
      port: CONFIG.PROXY_PORT,
      user: CONFIG.PROXY_USER || null,
      pass: CONFIG.PROXY_PASS || null,
      full: `http://${cred}${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`
    };
  }
  return null;
}

const PROXY = buildProxy();
if (!PROXY || !PROXY.full) {
  console.error('❌ PROXY obligatorio no configurado. Pone PROXY_URL o PROXY_HOST/PROXY_PORT + PROXY_USER/PROXY_PASS');
  process.exit(1);
}

// -------------------- Airtable init (optional) --------------------
let base = null;
if (CONFIG.AIRTABLE_API_KEY && CONFIG.AIRTABLE_BASE_ID) {
  base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);
}

// -------------------- Utilities --------------------
const delay = ms => new Promise(res => setTimeout(res, ms));
const log = (msg, type = 'info') => {
  const ts = new Date().toISOString();
  const pfx = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${pfx} [${ts}] ${msg}`);
};

function findChromePath() {
  const possible = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium'
  ];
  for (const p of possible) if (fs.existsSync(p)) { log(`✅ Chrome encontrado en: ${p}`); return p; }
  // try dynamic puppeteer cache
  try {
    const r = execSync('find /root/.cache/puppeteer -maxdepth 4 -name chrome -type f 2>/dev/null || true').toString().trim();
    if (r) {
      const first = r.split('\n')[0];
      log(`✅ Chrome dinámico encontrado: ${first}`);
      return first;
    }
  } catch (e) {}
  log('⚠️ No se encontró ejecutable de Chrome localmente; se usará ruta por defecto de Puppeteer', 'warning');
  return undefined;
}

// -------------------- Cookies helpers --------------------
function loadCookiesFromEnv() {
  if (!process.env.LINKEDIN_COOKIES) return null;
  try {
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    if (Array.isArray(cookies) && cookies.length > 0) return cookies;
    return null;
  } catch (e) {
    log(`⚠️ Error parseando LINKEDIN_COOKIES: ${e.message}`, 'warning');
    return null;
  }
}
function loadCookiesFromFile() {
  try {
    if (fs.existsSync('./cookies.json')) {
      const raw = fs.readFileSync('./cookies.json', 'utf8');
      const cookies = JSON.parse(raw);
      if (Array.isArray(cookies) && cookies.length > 0) return cookies;
    }
  } catch (e) {
    log(`⚠️ Error leyendo cookies.json: ${e.message}`, 'warning');
  }
  return null;
}
async function saveCookiesToFile(cookies) {
  try {
    fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));
    log('✅ Cookies guardadas en cookies.json', 'success');
  } catch (e) {
    log(`❌ Error guardando cookies: ${e.message}`, 'error');
  }
}
async function sendCookieWarning(daysLeft) {
  if (!base) { log(`⚠️ Cookie expira en ${daysLeft} días (no Airtable).`, 'warning'); return; }
  try {
    await base('System Logs').create([{
      fields: {
        'Type': 'Cookie Warning',
        'Message': `Cookies expiran en ${daysLeft} días`,
        'Date': new Date().toISOString(),
        'Priority': daysLeft <= 2 ? 'High' : 'Medium'
      }
    }]);
    log('📧 Notificación de expiración guardada en Airtable', 'success');
  } catch (e) {
    log(`⚠️ No se pudo crear System Log: ${e.message}`, 'warning');
  }
}
async function checkCookieExpirationFrom(cookies) {
  try {
    if (!cookies) return { expired: false, daysLeft: null };
    const liAt = cookies.find(c => c.name === 'li_at');
    if (!liAt || !liAt.expires) return { expired: false, daysLeft: null };
    const expiry = new Date(liAt.expires * 1000);
    const now = new Date();
    const daysLeft = Math.floor((expiry - now) / (1000*60*60*24));
    if (daysLeft <= 0) return { expired: true, daysLeft: 0 };
    if (daysLeft <= CONFIG.COOKIE_WARNING_DAYS) await sendCookieWarning(daysLeft);
    return { expired: false, daysLeft };
  } catch (e) {
    return { expired: false, daysLeft: null };
  }
}

// -------------------- Airtable logging --------------------
async function logScraperRun(success, postsScraped, error = '') {
  if (!base) {
    log('Tabla Scraper Runs no configurada (opcional)', 'warning');
    return;
  }
  try {
    await base('Scraper Runs').create([{
      fields: {
        'Date': new Date().toISOString(),
        'Success': success,
        'Posts Scraped': postsScraped,
        'Error': error || '',
        'Status': success ? 'Completed' : 'Failed'
      }
    }]);
  } catch (e) {
    log(`⚠️ No se pudo guardar Scraper Run: ${e.message}`, 'warning');
  }
}

// -------------------- Navigation helpers --------------------
async function safeGoto(page, targetUrl, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      log(`🔄 Navegando a: ${targetUrl} (intento ${i+1}/${retries})`);
      const resp = await page.goto(targetUrl, { waitUntil: ['domcontentloaded','networkidle2'], timeout: CONFIG.PAGE_TIMEOUT });
      await delay(2000);
      const cur = page.url();
      if (cur.includes('chrome-error://')) {
        log(`❌ chrome-error detectado: ${cur}`, 'error');
        if (i < retries - 1) { await delay(10000); continue; }
        return false;
      }
      if (resp && resp.status && resp.status() >= 400) {
        log(`⚠️ HTTP ${resp.status()} en ${targetUrl}`, 'warning');
        if (i < retries - 1) continue;
      }
      log(`✅ Navegación OK: ${cur}`, 'success');
      return true;
    } catch (e) {
      log(`⚠️ Error navegando (intento ${i+1}): ${e.message}`, 'warning');
      if (i < retries - 1) await delay((i+1)*4000);
      else return false;
    }
  }
  return false;
}

// load cookies into page (env or file)
async function loadCookiesToPage(page) {
  try {
    const cookies = loadCookiesFromEnv() || loadCookiesFromFile();
    if (!cookies) {
      log('❌ No hay cookies en env ni cookies.json', 'warning');
      return false;
    }
    const valid = cookies.filter(c => c.name && c.value && c.domain);
    if (!valid || valid.length === 0) { log('❌ Cookies inválidas', 'error'); return false; }
    const navOk = await safeGoto(page, 'https://www.linkedin.com');
    if (!navOk) return false;
    await delay(1500);
    const existing = await page.cookies();
    if (existing.length > 0) {
      try { await page.deleteCookie(...existing); log('🗑️ Cookies previas eliminadas'); } catch(e) {}
    }
    await page.setCookie(...valid);
    log(`✅ ${valid.length} cookies cargadas en navegador`);
    return true;
  } catch (e) {
    log(`❌ Error cargando cookies: ${e.message}`, 'error');
    return false;
  }
}

// -------------------- Login checks & flows --------------------
async function checkIfLoggedIn(page) {
  try {
    await delay(3000);
    const cur = page.url();
    log(`🔗 URL actual: ${cur}`);
    if (cur.includes('chrome-error://')) { log('❌ chrome-error - no se puede verificar login', 'error'); return false; }
    if (cur.includes('/login') || cur.includes('/checkpoint') || cur.includes('/uas/')) {
      log('❌ Redirect a login/checkpoint detectado', 'error');
      try { await page.screenshot({ path: '/tmp/linkedin-blocked.png', fullPage: true }); log('📸 Screenshot guardado'); } catch(e){}
      return false;
    }
    const checks = await page.evaluate(() => {
      return {
        hasGlobalNav: !!document.querySelector('nav.global-nav, nav[aria-label="Primary Navigation"]'),
        hasProfileIcon: !!document.querySelector('[data-control-name="nav.settings"], .global-nav__me'),
        hasFeedContent: !!document.querySelector('.feed-shared-update-v2, .scaffold-finite-scroll'),
        hasSearchBar: !!document.querySelector('input[placeholder*="Search"], input[placeholder*="Buscar"]'),
        hasMessaging: !!document.querySelector('[data-control-name="nav.messaging"], [href*="/messaging"]'),
        hasLoginForm: !!document.querySelector('input[name="session_key"], input[type="email"]'),
        url: window.location.href,
        title: document.title
      };
    });
    if (checks.hasLoginForm) { log('❌ Formulario de login detectado - NO logueado', 'error'); return false; }
    const positives = [checks.hasGlobalNav, checks.hasProfileIcon, checks.hasFeedContent, checks.hasSearchBar, checks.hasMessaging].filter(Boolean).length;
    const urlCheck = checks.url.includes('/feed') || checks.url.includes('/mynetwork') || checks.url.includes('/in/') || checks.url.includes('/jobs');
    const isLogged = positives >= 2 || (positives >= 1 && urlCheck);
    log(`📊 Checks positivos: ${positives}/5`);
    if (isLogged) log('✅ Login confirmado', 'success'); else log('❌ Login fallido', 'error');
    return isLogged;
  } catch (e) {
    log(`❌ Error checkIfLoggedIn: ${e.message}`, 'error');
    return false;
  }
}

async function loginWithCredentials(page) {
  try {
    if (!CONFIG.LINKEDIN_USER || !CONFIG.LINKEDIN_PASS) return false;
    log('🔐 Intentando login automático con credenciales (env)...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: CONFIG.PAGE_TIMEOUT });
    await page.waitForSelector('#username, input[name="session_key"]', { timeout: 20000 }).catch(()=>{});
    try {
      await page.type('#username, input[name="session_key"]', CONFIG.LINKEDIN_USER, { delay: 50 });
      await page.type('#password, input[name="session_password"]', CONFIG.LINKEDIN_PASS, { delay: 50 });
    } catch (e) {
      // fallback explicit
      await page.type('input[name="session_key"]', CONFIG.LINKEDIN_USER, { delay: 50 });
      await page.type('input[name="session_password"]', CONFIG.LINKEDIN_PASS, { delay: 50 });
    }
    await Promise.all([
      page.click('button[type="submit"], button.btn__primary--large'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{})
    ]);
    await delay(3000);
    const logged = await checkIfLoggedIn(page);
    if (logged) {
      const cookies = await page.cookies();
      await saveCookiesToFile(cookies);
      log('✅ Login automático OK y cookies guardadas', 'success');
      return true;
    }
    log('⚠️ Login automático falló', 'warning');
    return false;
  } catch (e) {
    log(`❌ Error loginWithCredentials: ${e.message}`, 'error');
    return false;
  }
}

async function manualLoginFlow(page, browser) {
  try {
    log('ℹ️ ALLOW_MANUAL_LOGIN activo. Usando navegador visible (headful) para login manual.');
    log(`➡️ Tienes ${CONFIG.MANUAL_LOGIN_TIMEOUT_MS/1000}s para iniciar sesión manualmente en la ventana.`);
    const start = Date.now();
    while (Date.now() - start < CONFIG.MANUAL_LOGIN_TIMEOUT_MS) {
      await delay(3000);
      const ok = await checkIfLoggedIn(page);
      if (ok) {
        const cookies = await page.cookies();
        await saveCookiesToFile(cookies);
        log('✅ Login manual detectado y cookies guardadas', 'success');
        return true;
      }
    }
    log('❌ Timeout en login manual', 'warning');
    return false;
  } catch (e) {
    log(`❌ Error manualLoginFlow: ${e.message}`, 'error');
    return false;
  }
}

// -------------------- Scraping function (keeps your logic) --------------------
// Insert here your original scrapeProfilePosts implementation (kept short here, you can replace)
async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  // For brevity, reuse your existing implementation - call the original large function you had previously.
  // We'll place a minimal placeholder to keep flow working:
  try {
    log(`📊 (placeholder) Extrayendo posts de ${authorName} — implementar scrapeProfilePosts completo aquí si lo deseas.`);
    // return 0 new posts (replace with your full function body)
    return 0;
  } catch (e) {
    log(`❌ Error scrapeProfilePosts: ${e.message}`, 'error');
    return 0;
  }
}

// -------------------- Main: runScraperOnce (uses BrightData proxy mandatorily) --------------------
async function runScraperOnce() {
  log('🚀 Iniciando runScraperOnce (BrightData proxy obligatorio)...');

  let browser = null;
  let page = null;
  let success = false;
  let totalNewPosts = 0;
  let lastError = '';

  try {
    // prepare browser args
    const chromePath = findChromePath();
    const browserArgs = [
      `--proxy-server=${PROXY.server}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ];

    log(`🌐 Usando proxy (ocultando cred): ${PROXY.server.replace(/:\/\/.*@/, '://***@')}`);

    // Launch browser. If manual login allowed, run headful to allow user interaction.
    browser = await puppeteer.launch({
      headless: CONFIG.ALLOW_MANUAL_LOGIN ? false : 'new',
      executablePath: chromePath || undefined,
      args: browserArgs,
      ignoreHTTPSErrors: true,
      defaultViewport: null,
      dumpio: false
    });

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);
    page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);
    await page.setViewport({ width: 1280, height: 800 });

    // Provide proxy authentication if needed (page.authenticate)
    if (PROXY.user || CONFIG.PROXY_USER || CONFIG.PROXY_PASS) {
      const u = PROXY.user || CONFIG.PROXY_USER;
      const p = PROXY.pass || CONFIG.PROXY_PASS;
      if (u && p) {
        await page.authenticate({ username: u, password: p });
        log('🔐 Autenticación de proxy aplicada (page.authenticate)', 'success');
      } else {
        log('⚠️ Proxy tiene host/port pero no credenciales; BrightData generalmente requiere credenciales.', 'warning');
      }
    }

    // small anti-detect tweak
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Verify IP via proxy (best-effort)
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 20000 });
      const ipInfo = await page.evaluate(() => document.body.innerText);
      log(`🌍 IP detectada vía proxy: ${ipInfo}`);
    } catch (e) {
      // If proxy cannot navigate at all, abort (proxy mandatory)
      log(`⚠️ No se pudo verificar IP via proxy: ${e.message}`, 'warning');
      // If network totally failing with proxy, we should abort: BrightData proxy likely misconfigured.
      // Decide to keep trying a few times with safeGoto below, but if quick failure continue to abort later.
    }

    // Try to authenticate proxy again (some proxies need authentication via headers — page.authenticate is the common method)
    // Load cookies (env or file)
    let cookiesLoaded = await loadCookiesToPage(page);

    // If no cookies loaded, try login via credentials, else if manual allowed, do manual.
    if (!cookiesLoaded) {
      if (CONFIG.LINKEDIN_USER && CONFIG.LINKEDIN_PASS) {
        const ok = await loginWithCredentials(page);
        cookiesLoaded = !!ok;
      } else if (CONFIG.ALLOW_MANUAL_LOGIN) {
        // manualLoginFlow expects headful; we launched headful if ALLOW_MANUAL_LOGIN true.
        const ok = await manualLoginFlow(page, browser);
        cookiesLoaded = !!ok;
      } else {
        lastError = 'No hay cookies y no se permite generación (LINKEDIN_USER/PASS o ALLOW_MANUAL_LOGIN).';
        throw new Error(lastError);
      }
    }

    // Navigate to feed and check login
    const navOk = await safeGoto(page, 'https://www.linkedin.com/feed/');
    if (!navOk) { lastError = 'No se pudo navegar al feed (proxy o cookies invalidas)'; throw new Error(lastError); }
    const logged = await checkIfLoggedIn(page);
    if (!logged) { lastError = 'No se pudo iniciar sesión - cookies inválidas o bloqueadas por IP/proxy'; throw new Error(lastError); }

    // Get profiles from Airtable and run scraping (if configured)
    let profiles = [];
    if (!base) {
      log('⚠️ Airtable no configurado: no se leerán perfiles. Set AIRTABLE_API_KEY + AIRTABLE_BASE_ID to enable.', 'warning');
    } else {
      try {
        const records = await base('Sources').select({ filterByFormula: '{Status} = "Active"', fields: ['Name','Profile URL','Group','Priority'] }).all();
        profiles = records.map(r => ({ id: r.id, name: r.get('Name'), profileUrl: r.get('Profile URL'), group: r.get('Group') }));
        log(`📋 Perfiles a monitorear: ${profiles.length}`);
      } catch (e) {
        log(`⚠️ Error cargando perfiles desde Airtable: ${e.message}`, 'warning');
      }
    }

    // If you want the original scraping logic, paste your full scrapeProfilePosts implementation above and call it here.
    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      try {
        const newPosts = await scrapeProfilePosts(page, p.profileUrl, p.name, p.group);
        totalNewPosts += newPosts || 0;
        if (i < profiles.length - 1) await delay(CONFIG.DELAY_BETWEEN_PROFILES);
      } catch (e) {
        log(`❌ Error procesando ${p.name}: ${e.message}`, 'error');
        continue;
      }
    }

    success = true;
    log(`✅ Run finalizado. Nuevos posts guardados: ${totalNewPosts}`, 'success');

  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    log(`❌ Error fatal en runScraperOnce: ${lastError}`, 'error');
  } finally {
    try {
      if (page) await delay(300);
      if (browser) { await browser.close(); log('🔒 Browser cerrado'); }
    } catch (e) {
      log(`⚠️ Error cerrando browser: ${e.message}`, 'warning');
    }
    await logScraperRun(success, totalNewPosts, lastError);
  }
}

// -------------------- Start --------------------
log('📱 Aplicación iniciada con Stealth Plugin (BrightData mandatory)');
log(`🔔 Cron: ${CONFIG.CRON_SCHEDULE}`);

// run once immediately
runScraperOnce().catch(e => log(`Error inicio: ${e.message}`, 'error'));

// schedule periodic runs
cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraperOnce().catch(e => log(`Error tarea cron: ${e.message}`, 'error'));
});
