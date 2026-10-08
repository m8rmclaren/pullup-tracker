#!/usr/bin/env bash
# Deploy from a laptop (CI does the same steps in .github/workflows/deploy.yml).
# Needs AWS credentials, TF_STATE_BUCKET and AWS_REGION.
#   scripts/deploy.sh            full deploy
#   scripts/deploy.sh --site     skip terraform, just rebuild and upload the site
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund
npm run check
npm run build
scripts/tf-init.sh
[[ "${1:-}" == "--site" ]] || terraform -chdir=infra apply -var "region=$AWS_REGION"
scripts/publish-site.sh
