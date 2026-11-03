# Build context is the repository root (see infra/docker-compose.yml).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
# Cache mounts: the pnpm store and metadata survive failed or repeated builds (flaky registry), and never land in an image layer.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store --mount=type=cache,target=/root/.cache/pnpm pnpm install --frozen-lockfile --filter @aegisops/web... \
 && pnpm --filter @aegisops/shared-types build \
 && pnpm --filter @aegisops/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
# npm/yarn are not needed at runtime; the copies bundled in the base image carry HIGH CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
