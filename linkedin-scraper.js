// linkedin-scraper.js
// Versión integrada: BrightData proxy + manejo robusto de cookies + login automático/manual
// Pega en tu repo y configura estas variables de entorno en Railway:
// AIRTABLE_API_KEY, AIRTABLE_BASE_ID, LINKEDIN_USER (opcional), LINKEDIN_PASS (opcional),
// LINKEDIN_COOKIES (opcional, JSON string), PROXY_URL (recomendado), ALLOW_MANUAL_LOGIN (true/false)

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { execSync } = require('child_process');
const fs = require('fs');
const Airtable = require('airtable');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  LINKEDIN_USER: process.env.LINKEDIN_USER,
  LINKEDIN_PASS: process.env.LINKEDIN_PASS,
  MAX_POSTS_PER_PROFILE: Number(process.env.MAX_POSTS_PER_PROFILE) || 10,
  DELAY_BETWEEN_PROFILES: Number(process.env.DELAY_BETWEEN_PROFILES) || 60000,
  DELAY_BETWEEN_ACTIONS: Number(process.env.DELAY_BETWEEN_ACTIONS) || 2000,
  PAGE_TIMEOUT: Number(process.env.PAGE_TIMEOUT) || 90000,
  MAX_RETRIES: Number(process.env.MAX_RETRIES) || 3,
  COOKIE_WARNING_DAYS: Number(process.env.COOKIE_WARNING_DAYS) || 5,
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 */6 * * *',
  PROXY_URL: process.env.PROXY_URL || 'http://brd-customer-hl_aede167c-zone-residential_proxy_scraper:0xtls13qh35l@brd.superproxy.io:33335',
  ALLOW_MANUAL_LOGIN: (process.env.ALLOW_MANUAL_LOGIN || 'false').toLowerCase() === 'true'
};

// Airtable base (if no keys provided, base will error when used — handled later)
let base = null;
if (CONFIG.AIRTABLE_API_KEY && CONFIG.AIRTABLE_BASE_ID) {
  base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);
}

// UTILIDADES
const delay = (ms) => new Promise(res => setTimeout(res, ms));
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
  for (const p of possible) if (fs.existsSync(p)) return p;
  return undefined;
}

// COOKIES: load from env or file
function loadCookiesFromEnv() {
  if (!process.env.LINKEDIN_COOKIES) return null;
  try {
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    if (Array.isArray(cookies) && cookies.length > 0) return cookies;
    return null;
  } catch (e) {
    log(`Error parseando LINKEDIN_COOKIES: ${e.message}`, 'warning');
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
    log(`Error leyendo cookies.json: ${e.message}`, 'warning');
  }
  return null;
}

async function saveCookiesToFile(cookies) {
  try {
    fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));
    log('✅ Cookies guardadas en cookies.json', 'success');
  } catch (e) {
    log(`Error guardando cookies: ${e.message}`, 'error');
  }
}

async function sendCookieWarning(daysLeft) {
  if (!base) {
    log(`Tabla System Logs no configurada. Cookie expira en ${daysLeft} días.`, 'warning');
    return;
  }
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
    log(`No se pudo crear System Log: ${e.message}`, 'warning');
  }
}

async function checkCookieExpirationFrom(cookies) {
  try {
    const liAt = (cookies || []).find(c => c.name === 'li_at');
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

// AIRTABLE helpers (sólo si base está configurada)
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
    log(`No se pudo guardar Scraper Run: ${e.message}`, 'warning');
  }
}

// SAFE GOTO con manejo de chrome-error
async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      log(`🔄 Navegando a: ${url} (intento ${i+1}/${retries})`);
      const response = await page.goto(url, { waitUntil: ['domcontentloaded','networkidle2'], timeout: CONFIG.PAGE_TIMEOUT });
      await delay(2500);
      const cur = page.url();
      if (cur.includes('chrome-error://')) {
        log(`❌ Error de conexión detectado: ${cur}`, 'error');
        if (i < retries - 1) {
          await delay(10000);
          continue;
        }
        return false;
      }
      if (response && response.status && response.status() >= 400) {
        log(`⚠️ Respuesta HTTP ${response.status()}`, 'warning');
        if (i < retries -1) continue;
      }
      log(`✅ Navegación exitosa a: ${cur}`, 'success');
      return true;
    } catch (e) {
      log(`⚠️ Error navegando (intento ${i+1}): ${e.message}`, 'warning');
      if (i < retries - 1) await delay((i+1)*4000);
      else return false;
    }
  }
  return false;
}

// Carga cookies en page (desde env/file)
async function loadCookiesToPage(page) {
  try {
    let cookies = loadCookiesFromEnv() || loadCookiesFromFile();
    if (!cookies) {
      log('❌ No hay cookies encontradas en env ni en cookies.json', 'warning');
      return false;
    }
    // Validate shape
    const validCookies = cookies.filter(c => c.name && c.value && c.domain);
    if (!validCookies || validCookies.length === 0) {
      log('❌ Cookies inválidas o vacías', 'error');
      return false;
    }
    // Primero navegar a linkedin para setCookie
    const navOk = await safeGoto(page, 'https://www.linkedin.com');
    if (!navOk) return false;
    await delay(2000);
    const existing = await page.cookies();
    if (existing.length > 0) {
      try { await page.deleteCookie(...existing); log('🗑️ Cookies previas eliminadas'); } catch(e){}
    }
    await page.setCookie(...validCookies);
    log(`✅ ${validCookies.length} cookies cargadas en el navegador`);
    return true;
  } catch (e) {
    log(`❌ Error cargando cookies al page: ${e.message}`, 'error');
    return false;
  }
}

// Verificar login en la página
async function checkIfLoggedIn(page) {
  try {
    await delay(4500);
    const currentUrl = page.url();
    log(`🔗 URL actual: ${currentUrl}`);
    if (currentUrl.includes('chrome-error://')) {
      log('❌ Error de conexión - no se puede verificar login', 'error');
      return false;
    }
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('/uas/')) {
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
    log(`🔍 Verificando login: Título: ${checks.title}`);
    if (checks.hasLoginForm) { log('❌ Formulario de login detectado - NO logueado', 'error'); return false; }
    const positiveChecks = [checks.hasGlobalNav, checks.hasProfileIcon, checks.hasFeedContent, checks.hasSearchBar, checks.hasMessaging].filter(Boolean).length;
    const urlCheck = checks.url.includes('/feed') || checks.url.includes('/mynetwork') || checks.url.includes('/in/') || checks.url.includes('/jobs');
    const isLoggedIn = positiveChecks >= 2 || (positiveChecks >= 1 && urlCheck);
    log(`📊 Checks positivos: ${positiveChecks}/5`);
    if (isLoggedIn) log('✅ Login confirmado', 'success'); else log('❌ Login fallido', 'error');
    return isLoggedIn;
  } catch (e) {
    log(`❌ Error verificando login: ${e.message}`, 'error');
    return false;
  }
}

// Intentar login automático con credenciales (si LINKEDIN_USER/PASS existen)
async function loginWithCredentials(page) {
  try {
    if (!CONFIG.LINKEDIN_USER || !CONFIG.LINKEDIN_PASS) return false;
    log('🔐 Intentando login automático con credenciales env...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: CONFIG.PAGE_TIMEOUT });
    await page.waitForSelector('#username, input[name="session_key"]', { timeout: 20000 });
    // Soporta diferentes selectores
    try {
      await page.type('#username, input[name="session_key"]', CONFIG.LINKEDIN_USER, { delay: 50 });
      await page.type('#password, input[name="session_password"]', CONFIG.LINKEDIN_PASS, { delay: 50 });
    } catch (e) {
      // fallback selectors
      await page.type('input[name="session_key"]', CONFIG.LINKEDIN_USER, { delay: 50 });
      await page.type('input[name="session_password"]', CONFIG.LINKEDIN_PASS, { delay: 50 });
    }
    await Promise.all([
      page.click('button[type="submit"], button.btn__primary--large'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{})
    ]);
    await delay(4000);
    const isLogged = await checkIfLoggedIn(page);
    if (isLogged) {
      const cookies = await page.cookies();
      await saveCookiesToFile(cookies);
      log('✅ Login automático OK y cookies guardadas', 'success');
      return true;
    }
    log('❌ Login automático falló', 'warning');
    return false;
  } catch (e) {
    log(`❌ Error en loginWithCredentials: ${e.message}`, 'error');
    return false;
  }
}

// Login manual (abre browser headless:false para que tú ingreses credenciales desde la consola/remote)
async function manualLoginFlow(page, browser) {
  try {
    log('ℹ️ ALLOW_MANUAL_LOGIN activado: abriendo navegador para login manual (headless:false).');
    log('➡️ Inicia sesión manualmente en la ventana del navegador y una vez completado espera en la consola hasta que termine la sesión.');
    log('Nota: en Railway puede ser necesario abrir webview/ports; si no es posible, usa login automático o generar cookies localmente y subir cookies.json a Railway.');
    // Esperar hasta que el usuario haga login manualmente.
    const maxWait = Number(process.env.MANUAL_LOGIN_TIMEOUT_MS) || 120000; // default 2 min
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await delay(3000);
      const logged = await checkIfLoggedIn(page);
      if (logged) {
        const cookies = await page.cookies();
        await saveCookiesToFile(cookies);
        log('✅ Login manual detectado y cookies guardadas', 'success');
        return true;
      }
    }
    log('❌ Timeout en login manual', 'warning');
    return false;
  } catch (e) {
    log(`❌ Error en manualLoginFlow: ${e.message}`, 'error');
    return false;
  }
}

// Función principal del scraper (simplificada para incluir proxy + cookie handling)
async function runScraperOnce() {
  log('🚀 Iniciando scraper de LinkedIn (runScraperOnce)...');

  let browser;
  let page;
  let success = false;
  let totalNew = 0;
  let lastError = '';

  try {
    // preparar args del navegador
    const chromePath = findChromePath();
    const browserArgs = [
      `--proxy-server=${CONFIG.PROXY_URL}`,
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

    log(`🌐 Usando proxy: ${CONFIG.PROXY_URL.replace(/:.+@/, ':***@')}`); // no mostrar credenciales claras

    // lanzar navegador (headless nuevo por defecto)
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

    // anti-detection tweaks
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Verificar IP (opcional)
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 20000 });
      const ipInfo = await page.evaluate(() => document.body.innerText);
      log(`🌍 IP detectada por el navegador: ${ipInfo}`);
    } catch (e) {
      log(`⚠️ No se pudo verificar IP pública: ${e.message}`, 'warning');
    }

    // Intentar cargar cookies (env o file)
    let cookiesLoaded = await loadCookiesToPage(page);

    // Si no hay cookies o cookies inválidas -> intentar login con credenciales
    if (!cookiesLoaded) {
      if (CONFIG.LINKEDIN_USER && CONFIG.LINKEDIN_PASS) {
        const credOk = await loginWithCredentials(page);
        cookiesLoaded = !!credOk;
      } else if (CONFIG.ALLOW_MANUAL_LOGIN) {
        // ya tenemos headless:false si ALLOW_MANUAL_LOGIN true
        const manualOk = await manualLoginFlow(page, browser);
        cookiesLoaded = !!manualOk;
      } else {
        log('❌ No hay cookies y no está permitida la generación automática/manual. Configure LINKEDIN_USER/LINKEDIN_PASS o ALLOW_MANUAL_LOGIN=true.', 'error');
        throw new Error('No cookies y no se puede generar');
      }
    }

    // Verificar login
    const navFeed = await safeGoto(page, 'https://www.linkedin.com/feed/');
    if (!navFeed) {
      lastError = 'No se pudo navegar al feed después de cargar cookies';
      throw new Error(lastError);
    }

    const logged = await checkIfLoggedIn(page);
    if (!logged) {
      lastError = 'No se pudo iniciar sesión - cookies inválidas o bloqueadas por IP';
      throw new Error(lastError);
    }

    // --- AQUÍ pegas O mantienes tu lógica de scraping ---
    // Por brevedad dejamos un ejemplo mínimo que consulta perfiles activos en Airtable y ejecuta scraping
    // Si necesitas que reemplace TODO tu antiguo scraping exactamente, puedo volcar tu código completo aquí.
    if (!base) {
      log('⚠️ Airtable no configurado, omitiendo lectura de perfiles (usa AIRTABLE_API_KEY + AIRTABLE_BASE_ID).', 'warning');
    } else {
      // obtener perfiles (mantener tu función original)
      let profiles = [];
      try {
        const records = await base('Sources').select({ filterByFormula: '{Status} = "Active"', fields: ['Name','Profile URL','Group','Priority'] }).all();
        profiles = records.map(r => ({ id: r.id, name: r.get('Name'), profileUrl: r.get('Profile URL'), group: r.get('Group') }));
        log(`📋 Perfiles a monitorear: ${profiles.length}`);
      } catch (e) {
        log(`⚠️ Error cargando perfiles desde Airtable: ${e.message}`, 'warning');
      }

      // Si tienes perfiles, podrías llamar a tu función scrapeProfilePosts aquí (reusar tu código)
      // Por ahora solo registramos y dejamos espacio para tu scraping completo.
      // Ejemplo: for each profile -> scrapeProfilePosts(page, profile.profileUrl, profile.name, profile.group)

      // (EL RESTO DE TU LÓGICA DE SCRAPING VA AQUÍ: copiar fielmente la función scrapeProfilePosts que usabas)
    }

    success = true;
    log('✅ Run completado sin errores fatales', 'success');

  } catch (err) {
    lastError = (err && err.message) ? err.message : String(err);
    log(`❌ Error fatal en runScraperOnce: ${lastError}`, 'error');
  } finally {
    try {
      if (page) await delay(500); // espera breve antes de cerrar
      if (browser) { await browser.close(); log('🔒 Browser cerrado'); }
    } catch (e) {
      log(`⚠️ Error cerrando browser: ${e.message}`, 'warning');
    }
    await logScraperRun(success, 0, lastError);
  }
}

// Ejecutar al iniciar
log('📱 Aplicación iniciada con Stealth Plugin');
log(`🔔 Sistema de monitoreo de cookies activo`);
log(`⏱️ Cron configurado: ${CONFIG.CRON_SCHEDULE}`);

// Lanzar primera ejecución (no bloqueante)
runScraperOnce().catch(e => log(`Error inicio: ${e.message}`, 'error'));

// Programar ejecuciones periódicas
cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraperOnce().catch(e => log(`Error tarea cron: ${e.message}`,'error'));
});
