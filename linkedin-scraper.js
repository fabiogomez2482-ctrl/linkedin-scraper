// linkedin-scraper-stealth.js
// Versión optimizada para Railway + Bright Data (proxy OBLIGATORIO)
// - Autenticación automática del proxy (URL o variables separadas)
// - Verificación de salida por proxy antes de LinkedIn
// - Intercepción sin bloquear 'stylesheet'
// - Manejo robusto de navegación/cookies

const puppeteer = require('puppeteer-extra');
const { execSync } = require('child_process');
const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Airtable = require('airtable');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,

  // Scraping
  MAX_POSTS_PER_PROFILE: 10,
  DELAY_BETWEEN_PROFILES: 60000,
  DELAY_BETWEEN_ACTIONS: 2000,
  PAGE_TIMEOUT: 90000,
  MAX_RETRIES: 3,

  // Cookies/alertas
  COOKIE_WARNING_DAYS: 5,
  CRON_SCHEDULE: '0 */6 * * *',

  // Proxy (OBLIGATORIO en este despliegue)
  PROXY_URL: process.env.PROXY_URL,
  PROXY_HOST: (process.env.PROXY_HOST || '').trim(),
  PROXY_PORT: (process.env.PROXY_PORT || '').trim(),
  PROXY_USERNAME: (process.env.PROXY_USERNAME || '').trim(),
  PROXY_PASSWORD: (process.env.PROXY_PASSWORD || '').trim(),

  // Hard-fail si no hay proxy
  REQUIRE_PROXY: true,
};

const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);

// =============== Utils ===============
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m, type='info') => {
  const t = new Date().toISOString();
  const p = type === 'error' ? '❌' : type === 'success' ? '✅' :
            type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${p} [${t}] ${m}`);
};

// Chrome path autodetect
function findChromePath() {
  try {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) {
      log(`✅ Chrome desde PUPPETEER_EXECUTABLE_PATH: ${envPath}`);
      return envPath;
    }
    const candidates = [
      '/root/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome',
      '/root/.cache/puppeteer/chrome/linux-130.0.6723.69/chrome-linux64/chrome',
      '/root/.cache/puppeteer/chrome/linux-129.0.6668.70/chrome-linux64/chrome',
      '/root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
    ];
    for (const p of candidates) if (fs.existsSync(p)) { log(`✅ Chrome encontrado en: ${p}`); return p; }
    try {
      const res = execSync('find /root/.cache/puppeteer -name chrome -type f 2>/dev/null || echo ""')
        .toString().trim();
      if (res) { const p = res.split('\n')[0]; log(`✅ Chrome encontrado dinámicamente: ${p}`); return p; }
    } catch {}
    log('⚠️ Chrome no encontrado, usando configuración por defecto');
    return undefined;
  } catch (e) {
    log(`⚠️ Error buscando Chrome: ${e.message}`, 'warning');
    return undefined;
  }
}

// =============== Proxy resolve & verify ===============
function resolveProxyFromEnv() {
  // Preferir PROXY_URL si viene completa
  if (CONFIG.PROXY_URL) {
    try {
      const u = new URL(CONFIG.PROXY_URL);
      const protocol = u.protocol.replace(':','') || 'http';
      const host = u.hostname;
      const port = u.port ? parseInt(u.port, 10) : (protocol === 'https' ? 443 : 80);
      const username = decodeURIComponent(u.username || '');
      const password = decodeURIComponent(u.password || '');
      if (!host || !port) throw new Error('URL proxy incompleta');

      return {
        serverArg: `${protocol}://${host}:${port}`,
        auth: (username && password) ? { username, password } : null,
        debug: `${protocol}://${host}:${port} (URL)`,
      };
    } catch (e) {
      log(`⚠️ PROXY_URL inválida: ${e.message}`, 'warning');
    }
  }

  // Variables separadas
  const host = CONFIG.PROXY_HOST;
  const port = CONFIG.PROXY_PORT;
  const username = CONFIG.PROXY_USERNAME;
  const password = CONFIG.PROXY_PASSWORD;

  if (host && port) {
    return {
      serverArg: `http://${host}:${port}`,
      auth: (username && password) ? { username, password } : null,
      debug: `http://${host}:${port} (split env)`,
    };
  }
  return null;
}

async function verifyProxyConnectivity(page) {
  // Bright Data test endpoint: debe devolver 200/OK y un body pequeño
  const testUrl = 'https://geo.brdtest.com/welcome.txt';
  log(`🔎 Verificando salida por proxy con: ${testUrl}`);
  try {
    const resp = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = resp ? resp.status() : 0;
    const text = resp ? await resp.text() : '';
    log(`🌐 Proxy check status=${status} body="${(text||'').substring(0,60)}"`);
    return status >= 200 && status < 400;
  } catch (e) {
    log(`❌ Proxy check falló: ${e.message}`, 'error');
    return false;
  }
}

// =============== Cookies / estado ===============
async function checkCookieExpiration() {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      log('⚠️ No hay cookies configuradas', 'warning');
      return { expired: true, daysLeft: 0 };
    }
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    const liAt = cookies.find(c => c.name === 'li_at');
    if (!liAt || !liAt.expires) {
      log('Cookie li_at no encontrada o sin fecha de expiración', 'warning');
      return { expired: false, daysLeft: 30 };
    }
    const expiryDate = new Date(liAt.expires * 1000);
    const daysLeft = Math.floor((expiryDate - new Date()) / 86400000);
    log(`📅 Cookies expiran en ${daysLeft} días (${expiryDate.toLocaleDateString()})`);
    if (daysLeft <= 0) return { expired: true, daysLeft: 0 };
    if (daysLeft <= CONFIG.COOKIE_WARNING_DAYS) log(`⚠️ ADVERTENCIA: expirarán pronto (${daysLeft} días)`, 'warning');
    return { expired: false, daysLeft };
  } catch (e) {
    log(`Error verificando cookies: ${e.message}`, 'error');
    return { expired: false, daysLeft: null };
  }
}

async function logScraperRun(success, postsScraped, error = null) {
  try {
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
    } catch {
      log(`Tabla Scraper Runs no configurada (opcional)`, 'warning');
    }
  } catch {}
}

// =============== Airtable helpers ===============
async function getActiveProfiles() {
  try {
    const records = await base('Sources')
      .select({ filterByFormula: '{Status} = "Active"', fields: ['Name','Profile URL','Group','Priority'] })
      .all();
    return records.map(r => ({
      id: r.id, name: r.get('Name'),
      profileUrl: r.get('Profile URL'),
      group: r.get('Group'), priority: r.get('Priority')
    }));
  } catch (e) { log(`Error obteniendo perfiles: ${e.message}`, 'error'); return []; }
}
async function postExists(postUrl) {
  try {
    const recs = await base('LinkedIn Posts')
      .select({ filterByFormula: `{Post URL} = "${postUrl}"`, maxRecords: 1 }).all();
    return recs.length > 0;
  } catch (e) { log(`Error verificando post: ${e.message}`, 'error'); return false; }
}
async function savePost(data) {
  try {
    await base('LinkedIn Posts').create([{
      fields: {
        'Author Name': data.authorName,
        'Author Profile URL': data.authorProfileUrl,
        'Group': data.group,
        'Post Content': data.content,
        'Post Date': data.date,
        'Post URL': data.postUrl,
        'Likes': data.likes || 0,
        'Comments': data.comments || 0,
        'Shares': data.shares || 0,
        'Has Media': data.hasMedia || false,
        'Media URL': data.mediaUrl || ''
      }
    }]);
    return true;
  } catch (e) { log(`Error guardando post: ${e.message}`, 'error'); return false; }
}

// =============== Navegación ===============
async function safeGoto(page, url, retries=3) {
  for (let i=0;i<retries;i++) {
    try {
      log(`🔄 Navegando a: ${url} (intento ${i+1}/${retries})`);
      const resp = await page.goto(url, {
        waitUntil: ['domcontentloaded','networkidle0'],
        timeout: CONFIG.PAGE_TIMEOUT
      });
      await delay(2000);
      const current = page.url();

      if (current.includes('chrome-error://')) {
        log(`❌ Error de conexión detectado: ${current}`, 'error');
        if (i < retries-1) { log('⏳ Esperando 10s antes de reintentar...'); await delay(10000); continue; }
        return false;
      }
      if (resp && resp.status() >= 400) {
        log(`⚠️ HTTP ${resp.status()} en ${url}`, 'warning');
        if (i < retries-1) continue;
      }
      log(`✅ Navegación exitosa a: ${current}`, 'success');
      return true;
    } catch (e) {
      log(`⚠️ Error navegando (intento ${i+1}): ${e.message}`, 'warning');
      if (i < retries-1) { const w=(i+1)*5000; log(`⏳ Esperando ${w/1000}s...`); await delay(w); }
      else return false;
    }
  }
  return false;
}

async function loadCookies(page) {
  try {
    if (!process.env.LINKEDIN_COOKIES) { log('❌ LINKEDIN_COOKIES no configurada', 'error'); return false; }
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    if (!Array.isArray(cookies) || cookies.length === 0) { log('❌ Cookies vacías/invalidas','error'); return false; }
    log(`📦 Cargando ${cookies.length} cookies...`);
    const navigated = await safeGoto(page, 'https://www.linkedin.com');
    if (!navigated) return false;
    await delay(1500);
    const existing = await page.cookies();
    if (existing.length) { await page.deleteCookie(...existing); log('🗑️ Cookies previas eliminadas'); }
    const valid = cookies.filter(c => c.name && c.value && c.domain);
    if (!valid.length) { log('❌ No hay cookies válidas para setear','error'); return false; }
    await page.setCookie(...valid);
    log(`✅ ${valid.length} cookies cargadas`);
    return true;
  } catch (e) { log(`❌ Error cargando cookies: ${e.message}`, 'error'); return false; }
}

async function checkIfLoggedIn(page) {
  try {
    await delay(3000);
    const url = page.url();
    if (url.includes('chrome-error://')) return false;
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/uas/')) return false;

    const checks = await page.evaluate(() => ({
      hasGlobalNav: !!document.querySelector('nav.global-nav, nav[aria-label="Primary Navigation"]'),
      hasProfileIcon: !!document.querySelector('[data-control-name="nav.settings"], .global-nav__me'),
      hasFeedContent: !!document.querySelector('.feed-shared-update-v2, .scaffold-finite-scroll'),
      hasSearchBar: !!document.querySelector('input[placeholder*="Search"], input[placeholder*="Buscar"]'),
      hasMessaging: !!document.querySelector('[data-control-name="nav.messaging"], [href*="/messaging"]'),
      hasLoginForm: !!document.querySelector('input[name="session_key"], input[type="email"]'),
      title: document.title
    }));
    if (checks.hasLoginForm) return false;
    const positives = [checks.hasGlobalNav, checks.hasProfileIcon, checks.hasFeedContent, checks.hasSearchBar, checks.hasMessaging].filter(Boolean).length;
    return positives >= 2;
  } catch { return false; }
}

async function loginWithCookies(page) {
  log('🍪 Intentando login con cookies...');
  const ok = await loadCookies(page);
  if (!ok) return false;

  log('🔄 Navegando al feed...');
  const nav = await safeGoto(page, 'https://www.linkedin.com/feed/');
  if (!nav) return false;

  const isIn = await checkIfLoggedIn(page);
  if (isIn) { log('✅ Login con cookies exitoso!', 'success'); return true; }

  log('🔄 Refrescando...');
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);
  return await checkIfLoggedIn(page);
}

async function loginToLinkedIn(page) {
  const ck = await checkCookieExpiration();
  if (ck.expired) { log('❌ Cookies expiradas', 'error'); return false; }
  const success = await loginWithCookies(page);
  if (!success) {
    log('❌ Login falló. Verifica cookies/proxy/sesión estable.', 'error');
  }
  return success;
}

// =============== Scraping ===============
async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  try {
    log(`📊 Extrayendo posts de: ${authorName}`);
    let activityUrl;
    if (profileUrl.includes('/company/')) {
      const clean = profileUrl.replace(/\/(posts?\/?)$/, '');
      activityUrl = `${clean}/posts/?feedView=all`;
      log(`🏢 Empresa detectada`);
    } else if (profileUrl.includes('/in/')) {
      activityUrl = `${profileUrl.replace(/\/$/, '')}/recent-activity/all/`;
      log(`👤 Persona detectada`);
    } else {
      log(`⚠️ Tipo de perfil no reconocido: ${profileUrl}`, 'error');
      return 0;
    }

    const nav = await safeGoto(page, activityUrl);
    if (!nav) return 0;

    await delay(3000);
    for (let i=0;i<8;i++){ await page.evaluate(()=>window.scrollBy(0, window.innerHeight)); await delay(2000); }
    await delay(2000);

    const posts = await page.evaluate((maxPosts) => {
      const out = [];
      const selectors = [
        'div.feed-shared-update-v2','li.profile-creator-shared-feed-update__container',
        'article.feed-shared-update-v2','li.profile-creator-shared-feed-update',
        'div[data-urn*="activity"]'
      ];
      function extractNumber(t){ if(!t) return 0; const s=t.replace(/[^\d,\.KMB]/gi,'').trim();
        if(!s) return 0; let m=1; const T=t.toUpperCase(); if(T.includes('K')) m=1e3; if(T.includes('M')) m=1e6; if(T.includes('B')) m=1e9;
        const n=parseFloat(s.replace(/,/g,'')); return isNaN(n)?0:Math.round(n*m);
      }
      function metrics(el){ const m={likes:0,comments:0,shares:0};
        const bar = el.querySelector('.social-details-social-activity, .social-details-social-counts');
        if (bar){
          const r = bar.querySelector('[aria-label*="reaction"], button[aria-label*="Like"], span[aria-hidden="true"]');
          if (r){ const t=r.textContent||r.getAttribute('aria-label')||''; m.likes=extractNumber(t); }
          const c = bar.querySelector('[aria-label*="comment"]');
          if (c){ const t=c.textContent||c.getAttribute('aria-label')||''; m.comments=extractNumber(t); }
          const s = bar.querySelector('[aria-label*="repost"], [aria-label*="share"]');
          if (s){ const t=s.textContent||s.getAttribute('aria-label')||''; m.shares=extractNumber(t); }
        }
        if (m.likes===0 || m.comments===0){
          el.querySelectorAll('button[aria-label], .social-details-social-counts__item').forEach(btn=>{
            const lab=btn.getAttribute('aria-label')||btn.textContent||''; const L=lab.toLowerCase();
            if (L.includes('like')||L.includes('reaction')) m.likes=Math.max(m.likes, extractNumber(lab));
            if (L.includes('comment')) m.comments=Math.max(m.comments, extractNumber(lab));
            if (L.includes('repost')||L.includes('share')) m.shares=Math.max(m.shares, extractNumber(lab));
          });
        }
        return m;
      }
      let nodes=[]; for (const sel of selectors){ nodes=document.querySelectorAll(sel); if(nodes.length) break; }
      if (!nodes.length) return out;
      for (let i=0;i<Math.min(nodes.length,maxPosts);i++){
        const post = nodes[i];
        try{
          const contentSel=['.feed-shared-update-v2__description','.update-components-text','.feed-shared-inline-show-more-text','.break-words'];
          let content=''; for (const s of contentSel){ const el=post.querySelector(s); if(el&&el.innerText&&el.innerText.trim().length>10){ content=el.innerText.trim(); break; } }
          if (!content || content.length<10) continue;
          let date=new Date().toISOString(); const timeEl=post.querySelector('time, [datetime]'); if (timeEl) date=timeEl.getAttribute('datetime')||timeEl.innerText||date;
          let postUrl=''; const link=post.querySelector('a[href*="/posts/"], a[href*="/activity-"]'); if (link) postUrl=link.href; if (!postUrl) continue;
          const m=metrics(post);
          const hasImage=!!post.querySelector('img[src*="media"], img[src*="dms/image"]');
          const hasVideo=!!post.querySelector('video, [data-test-id="video"]');
          out.push({ content: content.substring(0,1000), date, postUrl, likes:m.likes, comments:m.comments, shares:m.shares, hasMedia:(hasImage||hasVideo), mediaUrl:'' });
        }catch(e){}
      }
      return out;
    }, CONFIG.MAX_POSTS_PER_PROFILE);

    log(`📝 Encontrados ${posts.length} posts`);
    let newCount=0;
    for (const p of posts){
      const exists = await postExists(p.postUrl);
      if (!exists){
        const saved = await savePost({ authorName, authorProfileUrl: profileUrl, group, ...p });
        if (saved) { newCount++; log(`  ✓ Guardado: ${p.likes}L ${p.comments}C ${p.shares}S`); }
        await delay(400);
      }
    }
    log(`✅ ${newCount} posts nuevos guardados`, 'success');
    return newCount;

  } catch (e) {
    log(`Error scraping ${authorName}: ${e.message}`, 'error');
    return 0;
  }
}

// =============== Main runner ===============
async function runScraper() {
  log('🚀 Iniciando scraper de LinkedIn con Stealth...');

  // ---- Proxy obligatorio + diagnóstico ----
  const proxyCfg = resolveProxyFromEnv();
  const diag = {
    PROXY_URL_present: !!CONFIG.PROXY_URL,
    PROXY_HOST_present: !!CONFIG.PROXY_HOST,
    PROXY_PORT_present: !!CONFIG.PROXY_PORT,
    PROXY_USERNAME_present: !!CONFIG.PROXY_USERNAME,
    PROXY_PASSWORD_present: !!CONFIG.PROXY_PASSWORD
  };
  log(`🔧 Proxy env diag: ${JSON.stringify(diag)}`);

  if (!proxyCfg) {
    const msg = 'PROXY obligatorio no configurado. Define PROXY_URL o PROXY_HOST/PORT + PROXY_USERNAME/PROXY_PASSWORD';
    if (CONFIG.REQUIRE_PROXY) {
      log(`❌ ${msg}`, 'error');
      process.exit(1);
    } else {
      log(`ℹ️ ${msg}`, 'warning');
    }
  } else {
    const safe = proxyCfg.debug;
    log(`🌐 Usando proxy: ${safe}`);
  }

  let browser;
  let success=false, totalNew=0, fatal=null;

  try {
    const profiles = await getActiveProfiles();
    if (!profiles.length) { log('No hay perfiles activos','warning'); return; }
    log(`📋 Perfiles a monitorear: ${profiles.length}`);

    const args = [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote',
      '--single-process','--disable-gpu','--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920x1080',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      '--disable-background-networking','--disable-default-apps',
      '--disable-extensions','--disable-sync','--metrics-recording-only',
      '--mute-audio','--no-default-browser-check'
    ];
    if (proxyCfg) args.push(`--proxy-server=${proxyCfg.serverArg}`);

    const chromePath = findChromePath();
    browser = await puppeteer.launch({
      headless: 'new',
      args, executablePath: chromePath,
      ignoreHTTPSErrors: true, dumpio: false, defaultViewport: null
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);
    page.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);

    if (proxyCfg?.auth) { await page.authenticate(proxyCfg.auth); log('✅ Autenticación de proxy aplicada'); }

    await page.setViewport({ width:1920, height:1080 });

    // Interceptor (no bloquear stylesheet)
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['image','media','font'].includes(t)) req.abort(); else req.continue();
    });

    // ---- Verificación de salida por proxy antes de LinkedIn ----
    if (proxyCfg) {
      const ok = await verifyProxyConnectivity(page);
      if (!ok) {
        throw new Error('La verificación de salida por proxy falló. Revisa credenciales/allowlist/variables.');
      }
    }

    // ---- Login y scraping ----
    const loginOK = await loginToLinkedIn(page);
    if (!loginOK) throw new Error('No se pudo iniciar sesión - cookies inválidas o bloqueadas por IP');

    log('🎯 Iniciando extracción de posts...');
    for (let i=0;i<profiles.length;i++){
      const p = profiles[i];
      log(`\n[${i+1}/${profiles.length}] Procesando: ${p.name}`);
      try{
        const n = await scrapeProfilePosts(page, p.profileUrl, p.name, p.group);
        totalNew += n;
        if (i < profiles.length-1){ log(`⏳ Esperando ${CONFIG.DELAY_BETWEEN_PROFILES/1000}s...`); await delay(CONFIG.DELAY_BETWEEN_PROFILES); }
      }catch(e){ log(`❌ Error procesando ${p.name}: ${e.message}`, 'error'); }
    }

    success = true;
    log(`\n✅ Scraping completado. ${totalNew} posts nuevos guardados`, 'success');

  } catch (e) {
    fatal = e.message;
    log(`❌ Error fatal: ${fatal}`, 'error');
  } finally {
    if (browser) { await browser.close(); log('🔒 Browser cerrado'); }
    await logScraperRun(success, totalNew, fatal);
  }
}

// =============== Bootstrap ===============
log('📱 Aplicación iniciada con Stealth Plugin');
log('🔔 Sistema de monitoreo de cookies activo');

if (!process.env.LINKEDIN_COOKIES) {
  log('❌ ERROR: Variable LINKEDIN_COOKIES no configurada', 'error');
  process.exit(1);
}
if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
  log('❌ ERROR: Variables de Airtable no configuradas', 'error');
  process.exit(1);
}

runScraper().catch(err => { log(`Error fatal: ${err.message}`, 'error'); process.exit(1); });

cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraper().catch(err => { log(`Error en tarea programada: ${err.message}`, 'error'); });
});

log(`⏱️ Cron configurado: ${CONFIG.CRON_SCHEDULE}`);
