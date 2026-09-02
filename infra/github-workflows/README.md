# GitHub Actions workflows

These files belong in `.github/workflows/`. They are staged here instead
because GitHub refuses to let an OAuth token create or update a workflow file
without the `workflow` scope — a deliberate guard against an agent or
integration adding CI that runs code with the repository's credentials.

That guard is worth keeping. To install them:

    mkdir -p .github/workflows
    git mv infra/github-workflows/ci.yml         .github/workflows/ci.yml
    git mv infra/github-workflows/deploy.yml     .github/workflows/deploy.yml
    git mv infra/github-workflows/web-deploy.yml .github/workflows/web-deploy.yml
    git commit -m "Enable workflows" && git push

Read them first. `deploy.yml` fires Render deploy hooks from repository
secrets, `web-deploy.yml` builds the portal and deploys it to Cloudflare
Workers, and `ci.yml` runs the test suite against a live Postgres and Redis.

## What `web-deploy.yml` needs

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Overview, right-hand column |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Create → template **Edit Cloudflare Workers**, then add **Zone → DNS → Edit** and **Zone → SSL and Certificates → Edit** for `anystudio.ai` (custom domains create records and certificates) |

Three GitHub environments (Settings → Environments), each with variables:

| Environment | `API_ORIGIN` | `NEXT_PUBLIC_ADMIN_ORIGIN` | `WEB_URL` |
|---|---|---|---|
| `development` | `https://api.dev.anystudio.ai` | `https://admin.dev.anystudio.ai` | `https://dev.anystudio.ai` |
| `staging` | `https://api.staging.anystudio.ai` | `https://admin.staging.anystudio.ai` | `https://staging.anystudio.ai` |
| `production` | `https://api.anystudio.ai` | `https://admin.anystudio.ai` | `https://anystudio.ai` |

On `production`, add yourself under **Required reviewers**: that is what makes
a production deploy wait for a click.

Finally disconnect Cloudflare's own Git build on each Worker (Worker →
Settings → Build → Disconnect), or every merge deploys twice.
