# ---------- build: install deps + build the React client ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles a native addon when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*
# Manifests first so the dependency layers cache. The wildcards keep a missing lockfile from
# breaking the COPY (npm ci then says clearly that it needs one).
COPY package.json ./
COPY server/package*.json server/
COPY client/package*.json client/
RUN npm --prefix server ci --no-audit --no-fund \
 && npm --prefix client ci --no-audit --no-fund
COPY . .
# config/ may be empty (git doesn't track empty dirs): make sure it exists for the runtime COPY.
RUN node scripts/check-changelog.js \
 && npm --prefix client run build \
 && npm --prefix server prune --omit=dev --no-audit --no-fund \
 && mkdir -p config

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3710
WORKDIR /app
COPY --from=build /app/package.json /app/CHANGELOG.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/config ./config
COPY --from=build /app/client/dist ./client/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3710
CMD ["node", "server/src/index.js"]
