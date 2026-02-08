# ── Build stage ──────────────────────────────────────────────────────
# Compile native modules (better-sqlite3) with build tools
FROM node:20-bookworm-slim AS builder

LABEL org.opencontainers.image.title="BPS Prov Kaltara - Reminder Presensi"
LABEL org.opencontainers.image.description="WhatsApp bot untuk reminder presensi pegawai BPS Provinsi Kalimantan Utara"
LABEL org.opencontainers.image.vendor="BPS Provinsi Kalimantan Utara"

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Skip Chromium download — we'll use system Chromium in production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN npm ci --omit=dev

# ── Production stage ─────────────────────────────────────────────────
FROM node:20-bookworm-slim

# Install system Chromium + fonts + dumb-init for signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-freefont-ttf \
    fonts-noto-color-emoji \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Configure Puppeteer to use system Chromium (not bundled)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY package*.json ./
COPY src/ ./src/

# Create persistent directories
RUN mkdir -p data .wwebjs_auth .wwebjs_cache

# dumb-init as PID 1 ensures proper SIGTERM forwarding to Node
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "src/index.js"]
