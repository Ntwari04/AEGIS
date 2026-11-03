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

# Runtime image. (Follow-up: slim with `pnpm deploy --prod` once the Prisma client layout is settled.)
FROM build AS runtime
ENV NODE_ENV=production
RUN chown -R node:node /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["node", "dist/main.js"]
