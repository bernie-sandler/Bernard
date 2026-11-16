# syntax=docker/dockerfile:1

# Node 26 is the current LTS. Corepack is no longer bundled with Node 25+, so pnpm is installed with npm.
FROM node:26-slim AS base
RUN npm install -g pnpm@10.16.1 && npm cache clean --force
WORKDIR /app

# ── Dependencies (build tools only in case better-sqlite3 has no prebuilt binary) ──
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Build ──
FROM deps AS build
COPY . .
RUN pnpm build:server
RUN pnpm prune --prod --ignore-scripts

# ── Runtime ──
FROM base AS runtime
ENV NODE_ENV=production \
    DATABASE_PATH=/data/bernard.db \
    MIGRATIONS_DIR=/app/src/db/migrations \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
