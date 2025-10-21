// linkedin-scraper-stealth.js
// Versión corregida para Railway con mejor manejo de errores

const puppeteer = require('puppeteer-extra');
const { execSync } = require('child_process');
const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Airtable = require('airtable');
const cron = require('node-cron');
const express = require('express'); // <<-- AÑADIDO: Express para API

// Activar plugin stealth
puppeteer.use(StealthPlugin());

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
// ... (resto de CONFIG es igual) ...
  PROXY_PASSWORD: process.env.PROXY_PASSWORD,
};

const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);

// ----------------------------------------------------
// -- INICIO DE CÓDIGO JS ORIGINAL (sin cambios en funciones)
// ----------------------------------------------------

// ... (El código de UTILIDADES, GESTIÓN DE COOKIES, AIRTABLE, NAVEGACIÓN, SCRAPING debe permanecer igual) ...

// Función findChromePath (La mantenemos, pero la deshabilitamos para la ejecución de Puppeteer)
function findChromePath() {
    // ... (Mantener la función original, pero ya no la usaremos directamente en puppeteer.launch)
}

// ... (El resto de las funciones auxiliares hasta runScraper) ...

// ========================================
// FUNCION PRINCIPAL MODIFICADA
// ========================================

// Modificamos runScraper para aceptar parámetros de la API (si es necesario)
// Por simplicidad, por ahora la dejamos sin parámetros
async function runScraper() {
  log('🚀 Iniciando scraper de LinkedIn con Stealth...');
  
  let browser;
  let success = false;
  let totalNewPosts = 0;
  let error = null;
  
  try {
    await checkCookieExpiration();
    
    const profiles = await getActiveProfiles();
    
    // ... (resto de la lógica de runScraper es la misma) ...
    
    // Aquí es donde corregimos la detección de Chrome:
    // Ya que instalamos Chromium en el Dockerfile, NO buscamos con rutas rígidas.
    // Solo permitimos que Puppeteer use la variable de entorno PUPPETEER_EXECUTABLE_PATH
    
    const browserArgs = [
      '--no-sandbox',
      // ... (resto de browserArgs es igual) ...
    ];

    if (CONFIG.PROXY_HOST && CONFIG.PROXY_PORT) {
      browserArgs.push(`--proxy-server=${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`);
      log(`🌐 Usando proxy: ${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`);
    }
    
    // CORRECCIÓN CRÍTICA: Quitamos el findChromePath y usamos la variable de Dockerfile
    // const chromePath = findChromePath(); // <-- COMENTADO/ELIMINADO
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: browserArgs,
      // La ruta ejecutable ahora viene del Dockerfile: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
      ignoreHTTPSErrors: true,
      dumpio: false, 
      defaultViewport: null
    });
    
    // ... (resto del código de scraping hasta el final de runScraper) ...
    
  } catch (err) {
    error = err.message;
    log(`❌ Error fatal: ${error}`, 'error');
    throw err; // Es importante lanzar el error para el bloque de la API
  } finally {
    if (browser) {
      await browser.close();
      log('🔒 Browser cerrado');
    }
    
    await logScraperRun(success, totalNewPosts, error);
    return { success, totalNewPosts, error }; // Devolver el resultado
  }
}

// ========================================
// EJECUCIÓN PRINCIPAL (CON API)
// ========================================

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// 1. ENDPOINT PARA N8N (Dispara el scraper bajo demanda)
app.post('/scrape-on-demand', async (req, res) => {
    log('⚡️ API: Llamada de n8n recibida para scraping bajo demanda');
    
    // Responder inmediatamente (202 Accepted) para evitar timeouts de n8n, 
    // ya que el scraping es una tarea larga.
    res.status(202).send({ 
        status: 'Processing', 
        message: 'Scraper task initiated. Check logs for results.' 
    });

    // Ejecuta el scraper en background
    runScraper().catch(err => {
        log(`Error en API run: ${err.message}`, 'error');
    });
});

// 2. INICIO DEL SERVICIO
app.listen(PORT, () => {
    log(`✅ Servidor API Express corriendo en puerto ${PORT}`);
});

// 3. PROGRAMAR EJECUCIONES PERIÓDICAS (mantenemos el cron)
log(`⏱️ Cron configurado: ${CONFIG.CRON_SCHEDULE}`);
cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    log('⏰ Ejecutando tarea programada...');
    runScraper().catch(err => {
        log(`Error en tarea programada: ${err.message}`, 'error');
    });
});

// Inicialización de logs
log('📱 Aplicación iniciada con Stealth Plugin');
log('🔔 Sistema de monitoreo de cookies activo');

if (!process.env.LINKEDIN_COOKIES || !process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    log('❌ ERROR: Variables de entorno críticas faltantes.', 'error');
    log('💡 Por favor, configura LINKEDIN_COOKIES, AIRTABLE_API_KEY y AIRTABLE_BASE_ID en Railway.', 'warning');
    // NOTA: No hacemos process.exit(1) aquí porque queremos que Express inicie para depuración.
}
