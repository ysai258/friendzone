# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# One image, two entrypoints: the API server and the background worker. They
# share every dependency, so building them twice would only mean two things to
# keep in step.
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
RUN npm run build -w @friendzone/server \
 && npm run build -w @friendzone/web

# ---------------------------------------------------------------------------
FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production

# Only what the bundle could not include: native modules.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @friendzone/server --include-workspace-root \
 && npm cache clean --force

# The bundle already contains its migrations; the build step copies them in.
COPY --from=build /app/apps/server/dist ./dist

# Never run as root, and let the orchestrator's SIGTERM reach node directly so
# the drain sequence actually runs.
USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
FROM server AS worker
# Sharp is native and stayed out of the bundle; only the worker needs it.
USER root
RUN npm i --omit=dev sharp@^0.35.4 && npm cache clean --force
USER node
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]

# ---------------------------------------------------------------------------
FROM nginx:alpine AS web
# The web app is static files. Anything that is not a real file is the SPA
# shell, so a deep link like /r/AB7KQ loads rather than 404s.
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
