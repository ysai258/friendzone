# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Targets:
#   allinone  server + web on one origin. One container, one URL. Start here.
#   server    API and WebSocket only, for running the web app behind a CDN.
#   worker    background jobs (cleanup, image derivation).
#   web       static web app behind nginx, for the split deployment.
#
# Build content with real photographs by passing a contact address, as
# Wikimedia asks of automated clients:
#   docker build --build-arg WIKIMEDIA_USER_AGENT="FriendZone/1.0 (you@example.com)" .
# Without it the build generates placeholder art, which plays identically.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
# Manifests first, so a source change does not re-run the install layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/game-engine/package.json packages/game-engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .

ARG WIKIMEDIA_USER_AGENT=""
ENV WIKIMEDIA_USER_AGENT=${WIKIMEDIA_USER_AGENT}

# Blur Battle's images are generated, not committed — they are tens of
# megabytes of derived files. Built here, before the web build, so Vite copies
# them into dist along with everything else.
RUN if [ -n "$WIKIMEDIA_USER_AGENT" ]; then npm run dataset:fetch; else npm run dataset:sample; fi

RUN npm run build -w @friendzone/server \
 && npm run build -w @friendzone/web

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
# Only what the bundle could not include: native modules.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @friendzone/server --include-workspace-root \
 && npm cache clean --force
# The bundle carries its own migrations; the build step copies them in.
COPY --from=build /app/apps/server/dist ./dist
# Seed content: the authored datasets plus whatever the pipeline produced.
COPY --from=build /app/data/seed ./data/seed
COPY --from=build /app/data/out ./data/out
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ---------------------------------------------------------------------------
FROM runtime-base AS allinone
# One origin for the app, the API and the socket: no reverse proxy to
# configure, no CORS, and a same-origin WebSocket by construction.
COPY --from=build /app/apps/web/dist ./web
ENV WEB_DIST=/app/web
ENV DATA_DIR=/app/data
# A host that offers no release step can still come up playable.
ENV SEED_ON_BOOT=true
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
FROM runtime-base AS server
ENV DATA_DIR=/app/data
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
FROM runtime-base AS worker
# Sharp is native and stayed out of the bundle; only the worker needs it.
USER root
RUN npm i --omit=dev sharp@^0.35.4 && npm cache clean --force
USER node
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]

# ---------------------------------------------------------------------------
FROM nginx:alpine AS web
# The web app as static files. Anything that is not a real file is the SPA
# shell, so a deep link like /r/AB7KQ loads rather than 404s. This target
# expects an API reachable at http://server:8080.
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
