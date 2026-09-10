# GitHub Actions workflows

Files here belong in `.github/workflows/`. They are staged here because
GitHub refuses to let an OAuth token create or update a workflow file without
the `workflow` scope — a deliberate guard against an agent or integration
adding CI that runs code with the repository's credentials. That guard is
worth keeping, so a human moves them:

    git mv infra/github-workflows/api.yml .github/workflows/api.yml
    git rm .github/workflows/deploy.yml          # replaced by api.yml
    git commit -m "Deploy the API from GitHub Actions" && git push

Read a file before moving it. What is installed today:

| Workflow | File                            | Does                                                                                                                               |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **CI**   | `ci.yml`                        | Full suite on every PR and push: Prisma drift, lint, typecheck, migrate, seed, tests, build; pushes images to GHCR                 |
| **Web**  | `web-deploy.yml`                | Builds the portal with OpenNext and deploys it to Cloudflare Workers                                                               |
| **API**  | `api.yml` _(here, to be moved)_ | Checks the backend, then deploys the API and worker to Render at the tested commit, waits for live, smoke-tests through Cloudflare |

`deploy.yml` (Render deploy hooks fired after CI) is superseded by `api.yml`
and must go: with both present every backend merge deploys twice.

## What `api.yml` needs

One repository secret (Settings → Secrets and variables → Actions):

| Secret           | Value                                         |
| ---------------- | --------------------------------------------- |
| `RENDER_API_KEY` | Render → Account Settings → API Keys → Create |

Three variables on **each** GitHub environment (Settings → Environments →
`development` / `staging` / `production` → Environment variables). None is
sensitive — they are identifiers, not credentials:

| Variable                   | Value                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `RENDER_API_SERVICE_ID`    | the `srv-…` id of that environment's API service, from its dashboard URL                                |
| `RENDER_WORKER_SERVICE_ID` | the `srv-…` id of that environment's worker service                                                     |
| `API_URL`                  | optional — `https://anystudio-api-dev.onrender.com` until `api.dev.anystudio.ai` exists, then delete it |

The deploy job refuses to run, with a message naming what is missing, until
those are set. Every secret the _API itself_ needs (database, Google, Resend,
`APP_KEY`, …) lives in Render's env groups, not in GitHub — see
`docs/DEPLOY.md` §5.

## What `web-deploy.yml` needs

| Secret                  | Value                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Overview, right-hand column                                                                                                  |
| `CLOUDFLARE_API_TOKEN`  | My Profile → API Tokens → Create → template **Edit Cloudflare Workers**, then add **Zone → DNS → Edit** and **Zone → SSL and Certificates → Edit** for `anystudio.ai` |

No per-environment variables: the app derives its API and admin hostnames
from the request host, and the Worker's own runtime values live in
`apps/web/wrangler.jsonc` under each environment's `vars`.

## The one gate that matters

Create the **`production`** environment (Settings → Environments) and add
yourself under **Required reviewers**. Both deploy workflows target the
environment named after the branch, so that single setting makes every
production deploy — web and API — wait for a click. `development` and
`staging` are created automatically on first deploy.

Finally, disconnect Cloudflare's own Git build on each Worker (Worker →
Settings → Build → Disconnect), and leave `autoDeploy: false` in
`render.yaml` — otherwise every merge deploys twice.
