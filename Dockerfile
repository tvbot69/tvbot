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

# Prepare directory permissions for node user
RUN mkdir -p /app/.puppeteer /app/logs && chown -R node:node /app

# Copy production dependencies & built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src/persistence/prisma ./src/persistence/prisma

# Run as non-root user
USER node

# Expose healthcheck probe port (Railway automatically routes $PORT here)
EXPOSE 3000

# Run migrations then start with aggressive V8 heap limit tuned for Railway Free/Hobby (512MB RAM ceiling)
CMD ["sh", "-c", "npx prisma migrate deploy --schema src/persistence/prisma/schema.prisma && node --max-old-space-size=384 dist/bot/index.js"]
