const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cron = require('node-cron');
const Airtable = require('airtable');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ---- Configuración base ----
const BASE = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter(Boolean);

async function getBrowser() {
  for (const path of CHROME_PATHS) {
    if (fs.existsSync(path)) {
      console.log(`✅ Chrome detectado en: ${path}`);
      return puppeteer.launch({
        headless: true,
        executablePath: path,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--disable-extensions',
          '--disable-infobars',
          '--window-size=1280,720'
        ]
      });
    }
  }
  throw new Error('❌ No se encontró un ejecutable válido de Chrome.');
}

async function runScraper() {
  console.log('🚀 Iniciando scraper de LinkedIn...');
  let browser;

  try {
    browser = await getBrowser();
    const page = await browser.newPage();

    await page.goto('https://www.linkedin.com', { waitUntil: 'networkidle2' });
    console.log('✅ Página cargada correctamente.');

    // ... tu lógica de scraping aquí ...

  } catch (error) {
    console.error('❌ Error en scraper:', error.message);
  } finally {
    if (browser) await browser.close();
    console.log('🧹 Navegador cerrado.');
  }
}

// ---- Programar con cron (cada 6h, por ejemplo) ----
cron.schedule('0 */6 * * *', runScraper);

// ---- Ejecutar al iniciar ----
runScraper();
