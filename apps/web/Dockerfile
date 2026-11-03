# Build context is the repository root (see infra/docker-compose.yml).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile --filter @aegisops/web... \
 && pnpm --filter @aegisops/shared-types build \
 && pnpm --filter @aegisops/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
