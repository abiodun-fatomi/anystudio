# AnyStudio worker — BullMQ consumers. Same build, different entrypoint and
# scaled independently, because provider waits are where the time goes and they
# must not compete with webhook acknowledgements on the API.

FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/db/package.json     packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json     apps/worker/
RUN pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm db:generate
RUN pnpm --filter @anystudio/worker build
RUN pnpm --filter @anystudio/worker --prod deploy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# SIGTERM handling matters more here than anywhere: a generation that is killed
# halfway has already spent the customer's credits with the provider.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# No HTTP surface. Liveness is a heartbeat key the process refreshes in Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node dist/healthcheck.js
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/worker.js"]
