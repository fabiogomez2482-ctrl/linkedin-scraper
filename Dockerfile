FROM node:18-slim

RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    libxshmfence1 \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
RUN npx puppeteer browsers install chrome

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/root/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome

CMD ["node", "linkedin-scraper.js"]
