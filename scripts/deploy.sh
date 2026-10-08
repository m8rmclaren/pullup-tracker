#!/usr/bin/env bash
# Build, provision, upload. Safe to re-run; every step is idempotent.
#   scripts/deploy.sh            full deploy
#   scripts/deploy.sh --site     skip terraform, just rebuild and upload the site
set -euo pipefail
cd "$(dirname "$0")/.."

site_only=false
[[ "${1:-}" == "--site" ]] && site_only=true

npm ci --no-audit --no-fund
npm run check
npm run build

if ! $site_only; then
  terraform -chdir=infra init -input=false
  terraform -chdir=infra apply
fi

out() { terraform -chdir=infra output -raw "$1"; }
bucket=$(out site_bucket)
dist=$(out distribution_id)

# Hashed bundles never change, so cache them forever. Everything else (index.html,
# sw.js, manifest, icons) revalidates so a deploy is picked up on the next launch.
aws s3 sync dist/site/assets "s3://$bucket/assets" \
  --exclude "*.map" --cache-control "public,max-age=31536000,immutable"
aws s3 sync dist/site "s3://$bucket" \
  --exclude "assets/*" --exclude "manifest.webmanifest" --cache-control "no-cache" --delete
aws s3 cp dist/site/manifest.webmanifest "s3://$bucket/manifest.webmanifest" \
  --content-type "application/manifest+json" --cache-control "no-cache"
# Old hashed bundles are left in place on purpose: a phone still running the previous
# shell can keep loading them until its service worker updates.

aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" --query 'Invalidation.Id' --output text >/dev/null

echo
echo "Deployed: $(out app_url)"
if [[ "$(aws ssm get-parameter --name "$(out token_param_name)" --query Parameter.Value --output text)" == "unset" ]]; then
  echo "No token yet. Create one with: scripts/token.sh new"
fi
