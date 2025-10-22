// apify-bridge.js
// Usa Apify Actor como motor de scraping y persiste en Airtable con tu esquema

const axios = require('axios');
const Airtable = require('airtable');

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  APIFY_TOKEN: process.env.APIFY_TOKEN,
  APIFY_TASK_ID: process.env.APIFY_TASK_ID || null, // si creaste Task en Apify (opcional)
  ACTOR_ID: 'curious_coder~linkedin-post-search-scraper', // actor del marketplace
  USER_AGENT: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  LIMIT_PER_SOURCE: parseInt(process.env.LIMIT_PER_SOURCE || '15', 10),
  MIN_WAIT: parseInt(process.env.MIN_WAIT || '2', 10),
  MAX_WAIT: parseInt(process.env.MAX_WAIT || '8', 10),
};

const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m, t='info') => {
  const ts = new Date().toISOString();
  const p = t === 'error' ? '❌' : t === 'success' ? '✅' : t === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${p} [${ts}] ${m}`);
};

// ---- Airtable helpers (mismo esquema que ya usas) ----
async function getActiveProfiles() {
  try {
    const records = await base('Sources')
      .select({ filterByFormula: '{Status} = "Active"', fields: ['Name', 'Profile URL', 'Group', 'Priority'] })
      .all();

    return records.map(r => ({
      id: r.id,
      name: r.get('Name'),
      profileUrl: r.get('Profile URL'),
      group: r.get('Group'),
      priority: r.get('Priority'),
    })).filter(p => !!p.profileUrl);
  } catch (e) {
    log(`Error obteniendo perfiles: ${e.message}`, 'error');
    return [];
  }
}

async function postExists(postUrl) {
  try {
    const recs = await base('LinkedIn Posts')
      .select({ filterByFormula: `{Post URL} = "${postUrl}"`, maxRecords: 1 })
      .all();
    return recs.length > 0;
  } catch (e) {
    log(`Error verificando post: ${e.message}`, 'error');
    return false;
  }
}

async function savePost(post) {
  try {
    await base('LinkedIn Posts').create([{
      fields: {
        'Author Name': post.authorName || '',
        'Author Profile URL': post.authorProfileUrl || '',
        'Group': post.group || '',
        'Post Content': post.content || '',
        'Post Date': post.date || new Date().toISOString(),
        'Post URL': post.postUrl || '',
        'Likes': post.likes || 0,
        'Comments': post.comments || 0,
        'Shares': post.shares || 0,
        'Has Media': post.hasMedia || false,
        'Media URL': post.mediaUrl || ''
      }
    }]);
    return true;
  } catch (e) {
    log(`Error guardando post: ${e.message}`, 'error');
    return false;
  }
}

// ---- APIFY bridge ----
async function runApifyActor({ sourceUrls, cookiesJson }) {
  const token = CONFIG.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN no configurado');

  const input = {
    cookies: cookiesJson || [],
    userAgent: CONFIG.USER_AGENT,
    sourceUrls,
    limitPerSource: CONFIG.LIMIT_PER_SOURCE,
    scrapeAdditionalInfo: true,
    minWait: CONFIG.MIN_WAIT,
    maxWait: CONFIG.MAX_WAIT
  };

  let runId, datasetId;

  if (CONFIG.APIFY_TASK_ID) {
    log(`Lanzando Task ${CONFIG.APIFY_TASK_ID} en Apify...`);
    const start = await axios.post(
      `https://api.apify.com/v2/actor-tasks/${CONFIG.APIFY_TASK_ID}/runs?token=${token}`,
      input,
      { headers: { 'content-type': 'application/json' } }
    );
    runId = start.data.data.id;
    datasetId = start.data.data.defaultDatasetId;
  } else {
    log(`Lanzando Actor ${CONFIG.ACTOR_ID} en Apify...`);
    const start = await axios.post(
      `https://api.apify.com/v2/acts/${CONFIG.ACTOR_ID}/runs?token=${token}`,
      input,
      { headers: { 'content-type': 'application/json' } }
    );
    runId = start.data.data.id;
    datasetId = start.data.data.defaultDatasetId;
  }

  // polling
  let status = 'RUNNING';
  while (status === 'RUNNING' || status === 'READY' || status === 'STARTING' || status === 'REBOOTING') {
    await delay(5000);
    const res = await axios.get(`https://api.apify.com/v2/runs/${runId}?token=${token}`);
    status = res.data.data.status;
    datasetId = res.data.data.defaultDatasetId || datasetId;
    log(`Estado Apify: ${status}`);
  }

  if (status !== 'SUCCEEDED') throw new Error(`Actor terminó con estado: ${status}`);

  log(`Descargando dataset ${datasetId}...`);
  const itemsRes = await axios.get(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&format=json`
  );

  return itemsRes.data; // array de items
}

function normalizeItem(item) {
  // El Actor suele devolver campos como: postUrl/url, text/content, postedAt/time, likesCount...
  const postUrl = item.postUrl || item.url || '';
  const content = item.text || item.content || '';
  const date = item.postedAt || item.time || new Date().toISOString();
  const likes = item.likesCount || 0;
  const comments = item.commentsCount || 0;
  const shares = item.sharesCount || 0;
  const hasMedia = !!(item.hasImage || item.hasVideo || item.mediaUrl);
  const mediaUrl = item.mediaUrl || '';

  const authorName = item.authorName || item.author || '';
  const authorProfileUrl = item.authorProfileUrl || '';

  return { postUrl, content, date, likes, comments, shares, hasMedia, mediaUrl, authorName, authorProfileUrl };
}

async function main() {
  log('🧩 Bridge Apify → Airtable iniciado');

  if (!CONFIG.AIRTABLE_API_KEY || !CONFIG.AIRTABLE_BASE_ID) {
    throw new Error('Airtable API vars faltantes');
  }

  // 1) Leemos perfiles activos de Airtable
  const profiles = await getActiveProfiles();
  if (!profiles.length) {
    log('No hay perfiles activos en Airtable (tabla Sources).', 'warning');
    return;
  }
  const sourceUrls = profiles.map(p => p.profileUrl);
  log(`Sources a consultar: ${sourceUrls.length}`);

  // 2) Cookies desde ENV (igual que en tu scraper)
  const cookiesJson = process.env.LINKEDIN_COOKIES ? JSON.parse(process.env.LINKEDIN_COOKIES) : [];

  // 3) Ejecutar Actor en Apify
  const items = await runApifyActor({ sourceUrls, cookiesJson });
  log(`Items recibidos: ${items.length}`);

  // 4) Guardar en Airtable (evitando duplicados)
  let nuevos = 0;
  for (const it of items) {
    const norm = normalizeItem(it);
    if (!norm.postUrl) continue;

    const exists = await postExists(norm.postUrl);
    if (exists) continue;

    // encontrar el profile de origen para asignar Group/Author cuando sea posible
    const match = profiles.find(p => norm.authorProfileUrl && p.profileUrl && norm.authorProfileUrl.includes(p.profileUrl.split('?')[0].replace(/\/$/, '')));
    const group = match?.group || '';

    const saved = await savePost({
      authorName: norm.authorName,
      authorProfileUrl: norm.authorProfileUrl,
      group,
      content: norm.content?.slice(0, 1000),
      date: norm.date,
      postUrl: norm.postUrl,
      likes: norm.likes,
      comments: norm.comments,
      shares: norm.shares,
      hasMedia: norm.hasMedia,
      mediaUrl: norm.mediaUrl
    });
    if (saved) nuevos++;
    await delay(200);
  }

  log(`✅ Guardados ${nuevos} posts nuevos`, 'success');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
