#!/usr/bin/env bash
# terraform init against the remote state bucket made by infra/bootstrap.yaml.
# Needs TF_STATE_BUCKET and AWS_REGION in the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TF_STATE_BUCKET:?set TF_STATE_BUCKET (bootstrap stack output TfStateBucket)}"
: "${AWS_REGION:?set AWS_REGION}"
terraform -chdir=infra init -input=false -reconfigure \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="region=$AWS_REGION"
