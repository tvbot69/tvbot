# ==============================================================================
# Stage 1: Build & Dependencies
# ==============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency specifications and Prisma schema first for layer caching
COPY package*.json ./
COPY src/persistence/prisma/schema.prisma ./src/persistence/prisma/schema.prisma

# Install all dependencies (including devDependencies for build)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci

# Copy build config and source code
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# Generate Prisma Client & compile TypeScript to dist/
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Runner
# ==============================================================================
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Set container environment variables
ENV NODE_ENV=production
ENV ENVIRONMENT=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe

# Install Chromium, fonts (CJK, Arabic, Emojis for music stats), ffmpeg, and openssl
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-kacst \
    fonts-thai-tlwg \
    fonts-noto-color-emoji \
    ffmpeg \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy production dependencies & built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src/persistence/prisma ./src/persistence/prisma

# Prepare directory permissions and ensure binaries are executable
RUN mkdir -p /app/.puppeteer /app/logs \
    && find /app/node_modules -type f -name "ffprobe*" -exec chmod +x {} + 2>/dev/null || true \
    && find /app/node_modules -type f -name "ffmpeg*" -exec chmod +x {} + 2>/dev/null || true \
    && chown -R node:node /app

# Run as non-root user
USER node

# Expose healthcheck probe port (Railway automatically routes $PORT here)
EXPOSE 3000

# Synchronize full schema state to database, then start bot with aggressive V8 heap limit
CMD ["sh", "-c", "npx prisma db push --schema src/persistence/prisma/schema.prisma --skip-generate --accept-data-loss && node --max-old-space-size=384 dist/bot/index.js"]
