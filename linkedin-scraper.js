// linkedin-scraper.js
// Versión corregida para Railway con mejor manejo de errores
// Añadido: modo GENERATE_COOKIES para logueo manual en Railway y guardado de cookies

const puppeteer = require('puppeteer-extra');
const { execSync } = require('child_process');
const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Airtable = require('airtable');
const cron = require('node-cron');
const path = require('path');

// Activar plugin stealth
puppeteer.use(StealthPlugin());

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  LINKEDIN_EMAIL: process.env.LINKEDIN_EMAIL,
  LINKEDIN_PASSWORD: process.env.LINKEDIN_PASSWORD,

  MAX_POSTS_PER_PROFILE: 10,
  DELAY_BETWEEN_PROFILES: 60000,
  DELAY_BETWEEN_ACTIONS: 2000,
  PAGE_TIMEOUT: 90000,
  MAX_RETRIES: 3,

  COOKIE_WARNING_DAYS: 5,
  NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL,
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 */6 * * *',

  // Proxy (opcional pero RECOMENDADO para Railway)
  PROXY_HOST: process.env.PROXY_HOST,
  PROXY_PORT: process.env.PROXY_PORT,
  PROXY_USERNAME: process.env.PROXY_USERNAME,
  PROXY_PASSWORD: process.env.PROXY_PASSWORD,
};

// Airtable base (si está configurado)
let base;
if (CONFIG.AIRTABLE_API_KEY && CONFIG.AIRTABLE_BASE_ID) {
  base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);
}

// ========================================
// UTILIDADES
// ========================================
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message, type = 'info') => {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} [${timestamp}] ${message}`);
};

const TMP_COOKIES_PATH = path.join('/tmp', 'linkedin-cookies.json');
const GENERATE_COOKIES = process.env.GENERATE_COOKIES === 'true'; // setear true para login manual en Railway
// ========================================
// Función para encontrar Chrome automáticamente
// ========================================
function findChromePath() {
  try {
    const possiblePaths = [
      '/root/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome',
      '/root/.cache/puppeteer/chrome/linux-130.0.6723.69/chrome-linux64/chrome',
      '/root/.cache/puppeteer/chrome/linux-129.0.6668.70/chrome-linux64/chrome',
      '/root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        log(`✅ Chrome encontrado en: ${p}`);
        return p;
      }
    }

    try {
      const result = execSync('find /root/.cache/puppeteer -name chrome -type f 2>/dev/null || echo ""').toString().trim();
      if (result) {
        const chromePath = result.split('\n')[0];
        log(`✅ Chrome encontrado dinámicamente: ${chromePath}`);
        return chromePath;
      }
    } catch (e) {
      log('⚠️ No se pudo buscar Chrome dinámicamente');
    }

    log('⚠️ Chrome no encontrado, usando configuración por defecto');
    return undefined;
  } catch (error) {
    log(`⚠️ Error buscando Chrome: ${error.message}`);
    return undefined;
  }
}

// ========================================
// GESTIÓN DE COOKIES Y ESTADO (modificado para permitir GENERATE_COOKIES)
// ========================================
async function checkCookieExpiration() {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      log('⚠️ No hay cookies configuradas', 'warning');
      return { expired: true, daysLeft: 0 };
    }

    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    const liAtCookie = cookies.find((c) => c.name === 'li_at');

    if (!liAtCookie || !liAtCookie.expires) {
      log('Cookie li_at no encontrada o sin fecha de expiración', 'warning');
      return { expired: false, daysLeft: 30 };
    }

    const expiryDate = new Date(liAtCookie.expires * 1000);
    const now = new Date();
    const daysLeft = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));

    log(`📅 Cookies expiran en ${daysLeft} días (${expiryDate.toLocaleDateString()})`);

    if (daysLeft <= 0) {
      return { expired: true, daysLeft: 0 };
    }

    if (daysLeft <= CONFIG.COOKIE_WARNING_DAYS) {
      log(`⚠️ ADVERTENCIA: Las cookies expirarán pronto (${daysLeft} días)`, 'warning');
      await sendCookieWarning(daysLeft);
    }

    return { expired: false, daysLeft };
  } catch (error) {
    log(`Error verificando cookies: ${error.message}`, 'error');
    return { expired: false, daysLeft: null };
  }
}

async function sendCookieWarning(daysLeft) {
  try {
    if (!base) {
      log(`⚠️ Las cookies expiran en ${daysLeft} días. Tabla System Logs no configurada.`, 'warning');
      return;
    }
    try {
      await base('System Logs').create([
        {
          fields: {
            Type: 'Cookie Warning',
            Message: `Las cookies de LinkedIn expirarán en ${daysLeft} días. Renovarlas pronto.`,
            Date: new Date().toISOString(),
            Priority: daysLeft <= 2 ? 'High' : 'Medium'
          }
        }
      ]);
      log('📧 Notificación de expiración guardada en Airtable', 'success');
    } catch (e) {
      log('⚠️ Error guardando System Log en Airtable', 'warning');
    }
  } catch (error) {
    log(`Error enviando notificación: ${error.message}`, 'warning');
  }
}

async function logScraperRun(success, postsScraped, error = null) {
  try {
    if (!base) {
      log(`Tabla Scraper Runs no configurada (opcional)`, 'warning');
      return;
    }
    try {
      await base('Scraper Runs').create([
        {
          fields: {
            Date: new Date().toISOString(),
            Success: success,
            'Posts Scraped': postsScraped,
            Error: error || '',
            Status: success ? 'Completed' : 'Failed'
          }
        }
      ]);
    } catch (e) {
      log(`Tabla Scraper Runs no configurada (opcional)`, 'warning');
    }
  } catch (err) {
    // silencioso
  }
}

// ========================================
// FUNCIONES DE AIRTABLE (sin cambios)
// ========================================
async function getActiveProfiles() {
  try {
    if (!base) {
      log('⚠️ Airtable no configurado, no hay perfiles activos', 'warning');
      return [];
    }
    const records = await base('Sources')
      .select({
        filterByFormula: '{Status} = "Active"',
        fields: ['Name', 'Profile URL', 'Group', 'Priority']
      })
      .all();

    return records.map((record) => ({
      id: record.id,
      name: record.get('Name'),
      profileUrl: record.get('Profile URL'),
      group: record.get('Group'),
      priority: record.get('Priority')
    }));
  } catch (error) {
    log(`Error obteniendo perfiles: ${error.message}`, 'error');
    return [];
  }
}

async function postExists(postUrl) {
  try {
    if (!base) return false;
    const records = await base('LinkedIn Posts')
      .select({
        filterByFormula: `{Post URL} = "${postUrl}"`,
        maxRecords: 1
      })
      .all();

    return records.length > 0;
  } catch (error) {
    log(`Error verificando post: ${error.message}`, 'error');
    return false;
  }
}

async function savePost(postData) {
  try {
    if (!base) {
      log('⚠️ Airtable no configurado, el post no será guardado', 'warning');
      return false;
    }
    await base('LinkedIn Posts').create([
      {
        fields: {
          'Author Name': postData.authorName,
          'Author Profile URL': postData.authorProfileUrl,
          Group: postData.group,
          'Post Content': postData.content,
          'Post Date': postData.date,
          'Post URL': postData.postUrl,
          Likes: postData.likes || 0,
          Comments: postData.comments || 0,
          Shares: postData.shares || 0,
          'Has Media': postData.hasMedia || false,
          'Media URL': postData.mediaUrl || ''
        }
      }
    ]);
    return true;
  } catch (error) {
    log(`Error guardando post: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// NAVEGACIÓN MEJORADA - CORREGIDA
// ========================================
async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      log(`🔄 Navegando a: ${url} (intento ${i + 1}/${retries})`);

      const response = await page.goto(url, {
        waitUntil: ['domcontentloaded', 'networkidle0'],
        timeout: CONFIG.PAGE_TIMEOUT
      });

      await delay(3000);

      const currentUrl = page.url();

      // Verificar si hay error de conexión
      if (currentUrl.includes('chrome-error://')) {
        log(`❌ Error de conexión detectado: ${currentUrl}`, 'error');
        if (i < retries - 1) {
          log(`⏳ Esperando 10s antes de reintentar...`);
          await delay(10000);
          continue;
        }
        return false;
      }

      // Verificar si la respuesta fue exitosa
      if (response && response.status() >= 400) {
        log(`⚠️ Respuesta HTTP ${response.status()}`, 'warning');
        if (i < retries - 1) continue;
      }

      log(`✅ Navegación exitosa a: ${currentUrl}`, 'success');
      return true;
    } catch (error) {
      log(`⚠️ Error navegando (intento ${i + 1}): ${error.message}`, 'warning');

      if (i < retries - 1) {
        const waitTime = (i + 1) * 5000;
        log(`⏳ Esperando ${waitTime / 1000}s antes de reintentar...`);
        await delay(waitTime);
      } else {
        log(`❌ No se pudo navegar después de ${retries} intentos`, 'error');
        return false;
      }
    }
  }
  return false;
}

// ========================================
// CARGA DE COOKIES (modificada para aceptar LINKEDIN_COOKIES env o archivo temporal)
// ========================================
async function loadCookies(page) {
  try {
    let cookies = null;

    // 1) Preferir variable de entorno LINKEDIN_COOKIES
    if (process.env.LINKEDIN_COOKIES) {
      try {
        cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
      } catch (e) {
        log('❌ LINKEDIN_COOKIES no es JSON válido', 'error');
        return false;
      }
    }

    // 2) Fallback: archivo temporal (/tmp/linkedin-cookies.json) (útil cuando se generaron cookies con GENERATE_COOKIES)
    if (!cookies && fs.existsSync(TMP_COOKIES_PATH)) {
      try {
        const raw = fs.readFileSync(TMP_COOKIES_PATH, 'utf8');
        cookies = JSON.parse(raw);
        log('ℹ️ Cookies cargadas desde /tmp/linkedin-cookies.json');
      } catch (e) {
        log('⚠️ Error leyendo /tmp/linkedin-cookies.json', 'warning');
        cookies = null;
      }
    }

    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      log('❌ No se detectaron cookies válidas', 'error');
      return false;
    }

    log(`📦 Cargando ${cookies.length} cookies...`);

    // Navegar primero a LinkedIn con reintentos
    const navigated = await safeGoto(page, 'https://www.linkedin.com');
    if (!navigated) {
      log('❌ No se pudo cargar la página inicial de LinkedIn', 'error');
      return false;
    }

    await delay(3000);

    // Eliminar cookies existentes
    const existingCookies = await page.cookies();
    if (existingCookies.length > 0) {
      await page.deleteCookie(...existingCookies);
      log('🗑️ Cookies previas eliminadas');
    }

    // Validar cookies
    const validCookies = cookies.filter((cookie) => cookie.name && cookie.value && cookie.domain);
    if (validCookies.length === 0) {
      log('❌ No hay cookies válidas para cargar', 'error');
      return false;
    }

    await page.setCookie(...validCookies);
    log(`✅ ${validCookies.length} cookies cargadas`);

    return true;
  } catch (error) {
    log(`❌ Error cargando cookies: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// Verificar login (sin cambios funcionales)
// ========================================
async function checkIfLoggedIn(page) {
  try {
    await delay(5000);

    const currentUrl = page.url();
    log(`🔗 URL actual: ${currentUrl}`);

    // Verificar errores de conexión primero
    if (currentUrl.includes('chrome-error://')) {
      log('❌ Error de conexión - no se puede verificar login', 'error');
      return false;
    }

    // Si estamos en login, captcha o checkpoint = NO logueado
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('/uas/')) {
      log('❌ Detectado redirect a login/checkpoint/verificación', 'error');
      try {
        await page.screenshot({ path: '/tmp/linkedin-blocked.png', fullPage: true });
        log('📸 Screenshot guardado en /tmp/linkedin-blocked.png');
      } catch (e) {}
      return false;
    }

    const checks = await page.evaluate(() => {
      return {
        hasGlobalNav: document.querySelector('nav.global-nav, nav[aria-label="Primary Navigation"]') !== null,
        hasProfileIcon: document.querySelector('[data-control-name="nav.settings"], .global-nav__me') !== null,
        hasFeedContent: document.querySelector('.feed-shared-update-v2, .scaffold-finite-scroll') !== null,
        hasSearchBar: document.querySelector('input[placeholder*="Search"], input[placeholder*="Buscar"]') !== null,
        hasMessaging: document.querySelector('[data-control-name="nav.messaging"], [href*="/messaging"]') !== null,
        hasLoginForm: document.querySelector('input[name="session_key"], input[type="email"]') !== null,
        url: window.location.href,
        title: document.title
      };
    });

    log(`🔍 Verificando login:`);
    log(`  Título: ${checks.title}`);
    log(`  GlobalNav: ${checks.hasGlobalNav ? '✓' : '✗'}`);
    log(`  ProfileIcon: ${checks.hasProfileIcon ? '✓' : '✗'}`);
    log(`  FeedContent: ${checks.hasFeedContent ? '✓' : '✗'}`);
    log(`  SearchBar: ${checks.hasSearchBar ? '✓' : '✗'}`);
    log(`  LoginForm: ${checks.hasLoginForm ? '✓' : '✗'}`);

    if (checks.hasLoginForm) {
      log('❌ Formulario de login detectado - NO logueado', 'error');
      return false;
    }

    const positiveChecks = [
      checks.hasGlobalNav,
      checks.hasProfileIcon,
      checks.hasFeedContent,
      checks.hasSearchBar,
      checks.hasMessaging
    ].filter(Boolean).length;

    log(`📊 Checks positivos: ${positiveChecks}/5`);

    const urlCheck =
      checks.url.includes('/feed') ||
      checks.url.includes('/mynetwork') ||
      checks.url.includes('/in/') ||
      checks.url.includes('/jobs');

    const isLoggedIn = positiveChecks >= 2 || (positiveChecks >= 1 && urlCheck);

    if (isLoggedIn) {
      log('✅ Login confirmado', 'success');
    } else {
      log('❌ Login fallido', 'error');
    }

    return isLoggedIn;
  } catch (error) {
    log(`❌ Error verificando login: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// LOGIN CON COOKIES (mantiene lógica original)
// ========================================
async function loginWithCookies(page) {
  try {
    log('🍪 Intentando login con cookies...');

    const cookiesLoaded = await loadCookies(page);
    if (!cookiesLoaded) {
      log('❌ No se pudieron cargar las cookies', 'error');
      return false;
    }

    log('🔄 Navegando al feed...');
    const navigated = await safeGoto(page, 'https://www.linkedin.com/feed/');

    if (!navigated) {
      log('❌ No se pudo navegar al feed', 'error');
      return false;
    }

    await delay(8000);

    const isLoggedIn = await checkIfLoggedIn(page);

    if (isLoggedIn) {
      log('✅ Login con cookies exitoso!', 'success');
      return true;
    }

    log('🔄 Segundo intento: refrescando página...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await delay(5000);

    const secondCheck = await checkIfLoggedIn(page);

    if (secondCheck) {
      log('✅ Login exitoso en segundo intento!', 'success');
      return true;
    }

    log('❌ Cookies no válidas - necesitan renovarse', 'error');
    await sendCookieWarning(0);
    return false;
  } catch (error) {
    log(`❌ Error en login: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// LOGIN MANUAL PARA GENERAR COOKIES (NUEVO)
// - Si GENERATE_COOKIES=true el scraper abrirá Chromium en modo visible,
//   esperará a que completes login y guardará cookies en /tmp/linkedin-cookies.json
// - Luego imprime instrucciones para copiar esas cookies a la variable de entorno
// ========================================
async function runManualLoginAndSaveCookies(browser) {
  const page = await browser.newPage();
  try {
    log('🌐 Abriendo página de login de LinkedIn para generar cookies (modo visible)...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });

    log('👤 Por favor completa el login manualmente en la ventana abierta.');

    // Esperar hasta que checkIfLoggedIn devuelva true o hasta timeout (5 minutos)
    const start = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
    let logged = false;

    while (Date.now() - start < TIMEOUT_MS) {
      await delay(5000);
      try {
        const ok = await checkIfLoggedIn(page);
        if (ok) {
          logged = true;
          break;
        }
      } catch (e) {
        // ignore polling errors
      }
      log('⌛ Esperando login manual... (presiona Enter si ya finalizaste fuera de Railway)');
    }

    if (!logged) {
      log('❌ No se detectó login dentro del timeout. Puedes intentar nuevamente.', 'error');
      return false;
    }

    const cookies = await page.cookies();
    if (!cookies || cookies.length === 0) {
      log('❌ No se obtuvieron cookies tras el login', 'error');
      return false;
    }

    // Guardar cookies en /tmp para que el proceso las pueda usar (y puedas copiarlas)
    fs.writeFileSync(TMP_COOKIES_PATH, JSON.stringify(cookies, null, 2));
    log(`✅ ${cookies.length} cookies guardadas en ${TMP_COOKIES_PATH}`, 'success');

    // También imprimir una advertencia para copiar y pegar en Railway env var (si quieres)
    try {
      const asEnv = JSON.stringify(cookies);
      log('ℹ️ Copia el contenido de /tmp/linkedin-cookies.json y pégalo en la variable de entorno LINKEDIN_COOKIES en Railway (formato JSON).', 'info');
      // Para facilitar copia desde logs (si tu interfaz lo permite), imprimir un resumen corto
      log(`ℹ️ Primeras cookies: ${cookies.slice(0, 3).map(c => `${c.name}=${c.value.slice(0,6)}...`).join(' | ')}`, 'info');
      // No imprimimos el JSON entero por seguridad, pero si necesitas que lo haga lo puedo cambiar.
    } catch (e) {
      // ignore
    }

    return true;
  } catch (error) {
    log(`❌ Error en login manual: ${error.message}`, 'error');
    return false;
  } finally {
    try {
      await page.close();
    } catch (e) {}
  }
}

// ========================================
// LOGIN (coordinador) - si GENERATE_COOKIES -> lanza manual flow
// ========================================
async function loginToLinkedIn(page, browser) {
  try {
    // Si el flag GENERATE_COOKIES está activo, hacemos flujo manual
    if (GENERATE_COOKIES) {
      log('🔐 GENERATE_COOKIES=true -> iniciando flujo de login manual');
      // Abrimos un browser en modo visible si el actual es headless; para simplicidad, cerramos y relanzamos
      try {
        if (browser) {
          await browser.close();
        }
      } catch (e) {}
      const chromePath = findChromePath();
      const visibleBrowser = await puppeteer.launch({
        headless: false,
        executablePath: chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const ok = await runManualLoginAndSaveCookies(visibleBrowser);
      log('ℹ️ Login manual finalizado (recomendado: copiar cookies a env LINKEDIN_COOKIES).');
      // cerramos browser visible y salimos (para evitar que el proceso continúe con cookies temporales)
      try {
        await visibleBrowser.close();
      } catch (e) {}
      // Si cookies se guardaron, exit para que el operador copie y configure env var en Railway y vuelva a desplegar.
      if (ok) {
        log('ℹ️ Proceso detenido intencionalmente para que configures LINKEDIN_COOKIES en Railway.', 'info');
        process.exit(0);
      } else {
        return false;
      }
    }

    // Flow normal: validar expiración y usar cookies existentes
    const cookieStatus = await checkCookieExpiration();

    if (cookieStatus.expired) {
      log('❌ Las cookies han expirado. Por favor renuévalas.', 'error');
      return false;
    }

    const success = await loginWithCookies(page);

    if (!success) {
      log('❌ Login falló. Las cookies necesitan renovarse.', 'error');
      log('💡 Posibles causas:', 'warning');
      log('   - LinkedIn detectó la IP de Railway como sospechosa', 'warning');
      log('   - Las cookies se generaron desde otra IP', 'warning');
      log('   - Necesitas verificación de seguridad', 'warning');
      log('   - Problemas de conectividad de red', 'warning');
      log('   - SOLUCIÓN RECOMENDADA: Usar un proxy residencial', 'warning');
    }

    return success;
  } catch (error) {
    log(`Error crítico en login: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// SCRAPING DE POSTS (sin cambios funcionales, se mantiene tu lógica)
// ========================================
async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  try {
    log(`📊 Extrayendo posts de: ${authorName}`);

    let activityUrl;
    if (profileUrl.includes('/company/')) {
      const cleanUrl = profileUrl.replace(/\/(posts?\/?)$/, '');
      activityUrl = `${cleanUrl}/posts/?feedView=all`;
      log(`🏢 Perfil de empresa detectado`);
    } else if (profileUrl.includes('/in/')) {
      activityUrl = `${profileUrl.replace(/\/$/, '')}/recent-activity/all/`;
      log(`👤 Perfil personal detectado`);
    } else {
      log(`⚠️ Tipo de perfil no reconocido: ${profileUrl}`, 'error');
      return 0;
    }

    log(`🔗 URL: ${activityUrl}`);

    const navigated = await safeGoto(page, activityUrl);

    if (!navigated) {
      log(`No se pudo cargar perfil de ${authorName}`, 'error');
      return 0;
    }

    await delay(5000);

    log('📜 Scrolleando para cargar contenido...');
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2500);
    }

    await delay(3000);

    // Extraer posts con métricas
    const posts = await page.evaluate((maxPosts) => {
      const results = [];

      function extractNumber(text) {
        if (!text) return 0;
        const cleaned = text.replace(/[^\d,\.KMB]/gi, '').trim();
        if (!cleaned) return 0;

        let multiplier = 1;
        if (text.toUpperCase().includes('K')) multiplier = 1000;
        if (text.toUpperCase().includes('M')) multiplier = 1000000;
        if (text.toUpperCase().includes('B')) multiplier = 1000000000;

        const num = parseFloat(cleaned.replace(/,/g, ''));
        return isNaN(num) ? 0 : Math.round(num * multiplier);
      }

      function extractMetrics(postElement) {
        const metrics = { likes: 0, comments: 0, shares: 0 };

        try {
          const socialActionsBar = postElement.querySelector('.social-details-social-activity, .social-details-social-counts');

          if (socialActionsBar) {
            const reactionButton = socialActionsBar.querySelector('[aria-label*="reaction"], button[aria-label*="Like"], span[aria-hidden="true"]');
            if (reactionButton) {
              const reactionText = reactionButton.textContent || reactionButton.getAttribute('aria-label') || '';
              metrics.likes = extractNumber(reactionText);
            }

            const commentButton = socialActionsBar.querySelector('[aria-label*="comment"]');
            if (commentButton) {
              const commentText = commentButton.textContent || commentButton.getAttribute('aria-label') || '';
              metrics.comments = extractNumber(commentText);
            }

            const shareButton = socialActionsBar.querySelector('[aria-label*="repost"], [aria-label*="share"]');
            if (shareButton) {
              const shareText = shareButton.textContent || shareButton.getAttribute('aria-label') || '';
              metrics.shares = extractNumber(shareText);
            }
          }

          if (metrics.likes === 0 || metrics.comments === 0) {
            const actionButtons = postElement.querySelectorAll('button[aria-label], .social-details-social-counts__item');

            actionButtons.forEach((btn) => {
              const label = btn.getAttribute('aria-label') || btn.textContent || '';
              const lowerLabel = label.toLowerCase();

              if (lowerLabel.includes('like') || lowerLabel.includes('reaction')) {
                const num = extractNumber(label);
                if (num > metrics.likes) metrics.likes = num;
              }

              if (lowerLabel.includes('comment')) {
                const num = extractNumber(label);
                if (num > metrics.comments) metrics.comments = num;
              }

              if (lowerLabel.includes('repost') || lowerLabel.includes('share')) {
                const num = extractNumber(label);
                if (num > metrics.shares) metrics.shares = num;
              }
            });
          }
        } catch (err) {
          console.error('Error extrayendo métricas:', err);
        }

        return metrics;
      }

      const selectors = [
        'div.feed-shared-update-v2',
        'li.profile-creator-shared-feed-update__container',
        'article.feed-shared-update-v2',
        'li.profile-creator-shared-feed-update',
        'div[data-urn*="activity"]'
      ];

      let postElements = [];
      for (const selector of selectors) {
        postElements = document.querySelectorAll(selector);
        if (postElements.length > 0) break;
      }

      if (postElements.length === 0) {
        console.log('⚠️ No se encontraron posts');
        return [];
      }

      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const post = postElements[i];

        try {
          const contentSelectors = [
            '.feed-shared-update-v2__description',
            '.update-components-text',
            '.feed-shared-inline-show-more-text',
            '.break-words'
          ];

          let content = '';
          for (const sel of contentSelectors) {
            const el = post.querySelector(sel);
            if (el && el.innerText && el.innerText.trim().length > 10) {
              content = el.innerText.trim();
              break;
            }
          }

          if (!content || content.length < 10) continue;

          let date = new Date().toISOString();
          const timeEl = post.querySelector('time, [datetime]');
          if (timeEl) {
            date = timeEl.getAttribute('datetime') || timeEl.innerText || date;
          }

          let postUrl = '';
          const linkEl = post.querySelector('a[href*="/posts/"], a[href*="/activity-"]');
          if (linkEl) {
            postUrl = linkEl.href;
          }

          if (!postUrl) continue;

          const metrics = extractMetrics(post);

          const hasImage = post.querySelector('img[src*="media"], img[src*="dms/image"]') !== null;
          const hasVideo = post.querySelector('video, [data-test-id="video"]') !== null;

          results.push({
            content: content.substring(0, 1000),
            date,
            postUrl,
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
            hasMedia: hasImage || hasVideo,
            mediaUrl: ''
          });
        } catch (err) {
          console.error(`Error en post ${i}:`, err.message);
        }
      }

      return results;
    }, CONFIG.MAX_POSTS_PER_PROFILE);

    log(`📝 Encontrados ${posts.length} posts`);

    if (posts.length > 0) {
      const totalLikes = posts.reduce((sum, p) => sum + p.likes, 0);
      const totalComments = posts.reduce((sum, p) => sum + p.comments, 0);
      const totalShares = posts.reduce((sum, p) => sum + p.shares, 0);
      log(`📊 Total: ${totalLikes} likes, ${totalComments} comments, ${totalShares} shares`);
    }

    let newPostsCount = 0;
    for (const post of posts) {
      const exists = await postExists(post.postUrl);

      if (!exists) {
        const saved = await savePost({
          authorName,
          authorProfileUrl: profileUrl,
          group,
          ...post
        });

        if (saved) {
          newPostsCount++;
          log(`  ✓ Guardado: ${post.likes}L ${post.comments}C ${post.shares}S`);
        }
        await delay(500);
      }
    }

    log(`✅ ${newPostsCount} posts nuevos guardados`, 'success');
    return newPostsCount;
  } catch (error) {
    log(`Error scraping ${authorName}: ${error.message}`, 'error');
    return 0;
  }
}

// ========================================
// EJECUCIÓN PRINCIPAL
// ========================================
async function runScraper() {
  log('📱 Aplicación iniciada con Stealth Plugin');
  log('🔔 Sistema de monitoreo de cookies activo');

  // Validaciones mínimas - si GENERATE_COOKIES está activo, no es obligatorio LINKEDIN_COOKIES
  if (!GENERATE_COOKIES) {
    if (!process.env.LINKEDIN_COOKIES) {
      log('❌ ERROR: Variable LINKEDIN_COOKIES no configurada', 'error');
      log('💡 Si deseas generar cookies desde Railway, establece GENERATE_COOKIES=true y vuelve a desplegar', 'warning');
      process.exit(1);
    }
  }

  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    log('⚠️ Aviso: Variables de Airtable no configuradas. El salvado de posts es opcional.', 'warning');
  }

  let browser;
  let success = false;
  let totalNewPosts = 0;
  let error = null;

  try {
    // Cargar perfiles (si Airtable configurado)
    const profiles = await getActiveProfiles();

    if (!profiles || profiles.length === 0) {
      log('⚠️ No hay perfiles activos o Airtable no está configurado', 'warning');
      // si no hay perfiles no seguimos (pero si GENERATE_COOKIES=true, permitimos login manual)
      if (!GENERATE_COOKIES) return;
    }

    log(`📋 Perfiles a monitorear: ${profiles.length}`);

    // Argumentos mejorados para Railway
    const browserArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      // '--single-process', // comentado por estabilidad en algunos entornos
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920x1080',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check'
    ];

    if (CONFIG.PROXY_HOST && CONFIG.PROXY_PORT) {
      browserArgs.push(`--proxy-server=${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`);
      log(`🌐 Usando proxy: ${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`);
    }

    const chromePath = findChromePath();

    // Lanzar navegador (en modo headless "new" por defecto, a menos que GENERATE_COOKIES requiera visible)
    browser = await puppeteer.launch({
      headless: GENERATE_COOKIES ? false : 'new',
      args: browserArgs,
      executablePath: chromePath,
      ignoreHTTPSErrors: true,
      dumpio: false,
      defaultViewport: null
    });

    const page = await browser.newPage();

    // Configurar timeouts más largos
    page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);
    page.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);

    if (CONFIG.PROXY_USERNAME && CONFIG.PROXY_PASSWORD) {
      await page.authenticate({
        username: CONFIG.PROXY_USERNAME,
        password: CONFIG.PROXY_PASSWORD
      });
      log('✅ Autenticación de proxy configurada');
    }

    await page.setViewport({ width: 1920, height: 1080 });

    // Interceptar requests para mejorar velocidad (opcional)
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });
    } catch (e) {
      log('⚠️ No se pudo habilitar request interception', 'warning');
    }

    // Ejecutar login (si GENERATE_COOKIES=true el flujo manual será ejecutado y el proceso finalizará tras guardar cookies)
    const loginSuccess = await loginToLinkedIn(page, browser);

    if (!loginSuccess) {
      throw new Error('No se pudo iniciar sesión - cookies inválidas o bloqueadas por IP');
    }

    // Si llegamos aquí, y GENERATE_COOKIES estaba activo, habríamos salido antes con process.exit.
    // Scraping de perfiles
    log('🎯 Iniciando extracción de posts...');

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];

      log(`\n[${i + 1}/${profiles.length}] Procesando: ${profile.name}`);

      try {
        const newPosts = await scrapeProfilePosts(page, profile.profileUrl, profile.name, profile.group);

        totalNewPosts += newPosts;

        if (i < profiles.length - 1) {
          const waitTime = CONFIG.DELAY_BETWEEN_PROFILES;
          log(`⏳ Esperando ${waitTime / 1000}s antes del siguiente perfil...`);
          await delay(waitTime);
        }
      } catch (error) {
        log(`❌ Error procesando ${profile.name}: ${error.message}`, 'error');
        continue;
      }
    }

    success = true;
    log(`\n✅ Scraping completado. ${totalNewPosts} posts nuevos guardados`, 'success');
  } catch (err) {
    error = err && err.message ? err.message : String(err);
    log(`❌ Error fatal: ${error}`, 'error');
  } finally {
    if (browser) {
      try {
        await browser.close();
        log('🔒 Browser cerrado');
      } catch (e) {
        log('⚠️ Error cerrando browser', 'warning');
      }
    }

    await logScraperRun(success, totalNewPosts, error);
  }
}

// ========================================
// EJECUCIÓN: cron y arranque inmediato
// ========================================
log('📱 Aplicación iniciada con Stealth Plugin');
log('🔔 Sistema de monitoreo de cookies activo');

if (!GENERATE_COOKIES) {
  // Si no vamos a generar cookies, aseguramos que exista LINKEDIN_COOKIES antes de arrancar
  if (!process.env.LINKEDIN_COOKIES) {
    log('❌ ERROR: Variable LINKEDIN_COOKIES no configurada', 'error');
    log('💡 Si deseas generar cookies desde Railway, establece GENERATE_COOKIES=true y vuelve a desplegar', 'warning');
    process.exit(1);
  }
}

runScraper().catch((err) => {
  log(`Error fatal: ${err && err.message ? err.message : String(err)}`, 'error');
  process.exit(1);
});

cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraper().catch((err) => {
    log(`Error en tarea programada: ${err && err.message ? err.message : String(err)}`, 'error');
  });
});

log(`⏱️ Cron configurado: ${CONFIG.CRON_SCHEDULE}`);
