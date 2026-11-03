# Build context is the repository root (see infra/docker-compose.yml).
FROM node:22-alpine AS build
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile --filter @aegisops/api... \
 && pnpm --filter @aegisops/shared-types build \
 && pnpm --filter @aegisops/api build

# One-shot migration runner: `docker compose --profile tools run --rm migrate`
FROM build AS migrate
USER node
WORKDIR /repo/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]

# Runtime image: a fresh stage, so build-time layers (pnpm store, corepack cache) are not shipped.
# (Follow-up: slim further with pnpm deploy --prod once the Prisma client layout is settled.)
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# openssl is required by the Prisma engine. npm/yarn are not needed at runtime; the copies bundled in
# the base image carry HIGH CVEs.
RUN apk add --no-cache openssl \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["node", "dist/main.js"]
