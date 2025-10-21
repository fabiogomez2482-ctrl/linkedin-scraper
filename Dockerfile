# Dockerfile optimizado para Railway
FROM node:18-slim

# Instalar dependencias del sistema para Puppeteer (NECESARIO)
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    # AÑADIR chromium y unlinker para el manejo de Chromium
    chromium \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Establecer directorio de trabajo
WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependencias de Node.js, incluyendo Puppeteer
RUN npm install --omit=dev

# Establecer la ruta del ejecutable para Puppeteer
# Esto le dice a Puppeteer dónde encontrar el Chromium que instalamos arriba.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copiar código de la aplicación
COPY . .

# Variables de entorno
ENV NODE_ENV=production
ENV PORT=3000

# Exponer puerto (Railway lo asigna automáticamente)
EXPOSE 3000

# Crear directorio para screenshots
RUN mkdir -p /tmp

# Comando de inicio usando ENTRYPOINT para mayor robustez
ENTRYPOINT ["node", "linkedin-scraper.js"]
