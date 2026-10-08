#!/usr/bin/env bash
# Upload dist/site to the site bucket and invalidate CloudFront. Reads names from terraform outputs.
set -euo pipefail
cd "$(dirname "$0")/.."

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
echo "Published to $(out app_url)"
