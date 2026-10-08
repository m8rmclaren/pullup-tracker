#!/usr/bin/env bash
# Manage API tokens. Only SHA-256 digests are stored (in SSM); the token itself is
# printed once and lives on your devices.
#
#   scripts/token.sh new            add a token alongside any existing ones
#   scripts/token.sh list           show the digests that are currently valid
#   scripts/token.sh revoke <hex>   revoke the digest starting with <hex>
#   scripts/token.sh revoke-all     revoke every token (then run `new`)
#
# The Lambda caches the list for up to 60s, so changes take effect within a minute.
# Needs only the AWS CLI and openssl (AWS CloudShell has both). Set TOKEN_PARAM if you
# changed the Terraform `name` variable.
set -euo pipefail
cd "$(dirname "$0")/.."

param="${TOKEN_PARAM:-/pullups/token-hashes}"
current() {
  local v
  v=$(aws ssm get-parameter --name "$param" --query Parameter.Value --output text)
  [[ "$v" == "unset" ]] && v=""
  tr ', ' '\n\n' <<<"$v" | grep -E '^[0-9a-f]{64}$' || true
}
store() {
  local v
  v=$(paste -sd, - | sed 's/^$/unset/')
  aws ssm put-parameter --name "$param" --type String --overwrite --value "${v:-unset}" >/dev/null
}
sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | awk '{print $1}'; }

case "${1:-}" in
  new)
    token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
    hash=$(printf %s "$token" | sha)
    { current; echo "$hash"; } | store
    echo "New token (shown once — paste it into Settings on each device):"
    echo
    echo "  $token"
    echo
    echo "digest: $hash"
    ;;
  list)
    current
    ;;
  revoke)
    prefix="${2:?usage: token.sh revoke <digest-prefix>}"
    matches=$(current | grep -c "^$prefix" || true)
    [[ "$matches" == 1 ]] || { echo "prefix matches $matches digests; need exactly 1" >&2; exit 1; }
    current | grep -v "^$prefix" | store
    echo "revoked $prefix…"
    ;;
  revoke-all)
    printf '' | store
    echo "all tokens revoked"
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
