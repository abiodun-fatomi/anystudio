# AnyStudio worker — BullMQ consumers. Same build, different entrypoint and
# scaled independently, because provider waits are where the time goes and they
# must not compete with webhook acknowledgements on the API.

FROM node:22-slim AS deps
RUN corepack enable
# openssl in the BUILD stage, not just the runtime one: `prisma generate`
# chooses which query-engine binary to embed by detecting the libssl version,
# and node:22-slim ships none. Without this it silently picks the
# openssl-1.1.x engine and bakes it into an image whose runtime has openssl 3,
# where it then fails to load.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
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
# `...` = the package and everything it depends on, in topological order,
# so @anystudio/shared is compiled to dist before this app is.
RUN pnpm --filter @anystudio/worker... build
RUN pnpm --filter @anystudio/worker --prod deploy /out

# Same trap as the API image: `prisma generate` writes the client into
# node_modules, and `pnpm deploy` rebuilds node_modules from the store rather
# than copying it — so the client generated above is not in /out, and the
# worker would die on its first import. Generate it in the shipping tree, then
# prove it, so a broken client fails the build instead of a deploy.
RUN cp -r packages/db/prisma /out/prisma
RUN cd /out && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
ENV PRISMA_SMOKE_URL=postgresql://u:p@127.0.0.1:5432/d
RUN cd /out \
 && DATABASE_URL=$PRISMA_SMOKE_URL DIRECT_URL=$PRISMA_SMOKE_URL \
    node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient();console.log('prisma client OK')"

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# SIGTERM handling matters more here than anywhere: a generation that is killed
# halfway has already spent the customer's credits with the provider.
# openssl: the Prisma engines link against libssl, absent from the slim image.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# No HTTP surface. Liveness is a heartbeat key the process refreshes in Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node dist/healthcheck.js
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/worker.js"]
