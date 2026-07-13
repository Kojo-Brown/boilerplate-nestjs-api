# Workflow Templates

Copy these files to `.github/workflows/` to activate them in your repository.

| File | Purpose |
|------|---------|
| `ci.yml` | Lint → Type Check → Test (with Postgres + Redis services) → Build & Push Docker image to GHCR |

## Required Secrets

| Secret | Description |
|--------|-------------|
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions — used for GHCR login |

## Required Repository Variables (optional overrides)

Set these as GitHub Actions environment secrets for production use:

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Production JWT signing secret |
| `JWT_REFRESH_SECRET` | Production JWT refresh signing secret |

## Docker Image

On every push to `main`, the CI pipeline builds and pushes:

```
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:sha-<commit-sha>
```
