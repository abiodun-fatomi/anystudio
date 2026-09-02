# GitHub Actions workflows

These two files belong in `.github/workflows/`. They are staged here instead
because GitHub refuses to let an OAuth token create or update a workflow file
without the `workflow` scope — a deliberate guard against an agent or
integration adding CI that runs code with the repository's credentials.

That guard is worth keeping. To install them:

    cp infra/github-workflows/ci.yml     .github/workflows/ci.yml
    cp infra/github-workflows/deploy.yml .github/workflows/deploy.yml
    git add .github/workflows && git commit -m "Add CI and deploy workflows" && git push

Read them first. `deploy.yml` fires Render deploy hooks from repository
secrets, and `ci.yml` runs the test suite against a live Postgres and Redis.
