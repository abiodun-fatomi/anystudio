# AnyStudio API — multi-stage, non-root, no build tooling in the final image.
#
# The one ordering rule that matters: `prisma generate` MUST run before tsc.
# Without the generated client, typecheck fails on every import of @prisma/client
# and the error points at your code rather than at the missing step.

# ---- deps: cached against the lockfile alone --------------------------------
FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/db/package.json     packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json        apps/api/
# fetch, not install: editing a source file must not invalidate this layer
RUN pnpm fetch --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm db:generate
# `...` = the package and everything it depends on, in topological order,
# so @anystudio/shared is compiled to dist before this app is.
RUN pnpm --filter @anystudio/api... build
RUN pnpm --filter @anystudio/api --prod deploy /out

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# tini reaps zombies and forwards SIGTERM, so an in-flight request finishes
# instead of being cut off mid-deploy.
# openssl: the Prisma engines link against libssl, which the slim image
# does not ship. Without it the first query fails with a load error.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# The schema and migrations ride along so that `npm run db:deploy` — Render's
# pre-deploy command, run in THIS image once per deploy before any new
# instance starts — can apply them. Nothing in the runtime path reads them.
COPY --from=build --chown=node:node /repo/packages/db/prisma ./prisma
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
