# Workflow Templates

The CI pipeline now lives at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and
runs on every pull request. This directory previously held a parked copy because the
publishing token lacked the `workflow` scope; that restriction no longer applies, so the
workflow is maintained in `.github/workflows/` directly.

## Required Secrets

| Secret         | Description                                           |
| -------------- | ----------------------------------------------------- |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions — used for GHCR login |

## Optional CI Secrets

The test job falls back to obviously-fake values when these are unset, so CI works on
forks without any configuration.

| Secret                     | Description           |
| -------------------------- | --------------------- |
| `CI_AWS_ACCESS_KEY_ID`     | S3 integration tests  |
| `CI_AWS_SECRET_ACCESS_KEY` | S3 integration tests  |
| `CI_S3_BUCKET`             | S3 bucket name        |
| `CI_GOOGLE_CLIENT_ID`      | Google OAuth strategy |
| `CI_GOOGLE_CLIENT_SECRET`  | Google OAuth strategy |

JWT signing secrets are generated per-run with `openssl rand`, so no stored secret is
needed for tests.

## Docker Image

On every push to `main`, the CI pipeline builds and pushes:

```
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:sha-<commit-sha>
```
