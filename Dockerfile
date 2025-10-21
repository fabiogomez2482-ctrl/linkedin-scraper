# ---- Base image ----
FROM node:18-slim

# ---- Instalar dependencias del sistema necesarias para Chromium ----
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libxcomposite1 \
    libxrandr2 \
    libxdamage1 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libx11-xcb1 \
    libxfixes3 \
    libxext6 \
    libexpat1 \
    && rm -rf /var/lib/apt/lists/*

# ---- Variables de entorno ----
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=3000

# ---- Crear directorio de la app ----
WORKDIR /app

# ---- Copiar archivos de la app ----
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# ---- Exponer puerto y ejecutar ----
EXPOSE 3000
CMD ["node", "linkedin-scraper.js"]
