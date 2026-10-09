#!/usr/bin/env bash
# Admin access to accounts. Day to day, people invite each other from Settings in the app;
# this is for the first invite, recovering a lost account, and revoking access.
#
#   scripts/invite.sh new               print a single-use invite link for a new person (7 days)
#   scripts/invite.sh device <userId>   print a link that signs a device into <userId> (15 min)
#   scripts/invite.sh users             list accounts
#   scripts/invite.sh revoke <userId>   sign every device of <userId> out (takes effect within a minute)
#
# Only SHA-256 digests of codes and tokens are stored. Needs the AWS CLI and openssl (AWS
# CloudShell has both). Set TABLE if you changed the Terraform `name` variable, and APP_URL
# if the CloudFront lookup below can't find the app.
set -euo pipefail

table="${TABLE:-pullups}"
sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | awk '{print $1}'; }

app_url() {
  if [[ -n "${APP_URL:-}" ]]; then echo "${APP_URL%/}"; return; fi
  local host
  host=$(aws cloudfront list-distributions --output text \
    --query "DistributionList.Items[?Comment=='${table} pull-up tracker'] | [0].[Aliases.Items[0], DomainName]" |
    awk '{print ($1 != "None" ? $1 : $2)}')
  [[ -n "$host" && "$host" != "None" ]] || { echo "can't find the CloudFront distribution; set APP_URL" >&2; exit 1; }
  echo "https://$host"
}

# put_invite <kind> <ttl-seconds> [userId]
put_invite() {
  local kind=$1 ttl_seconds=$2 user_id=${3:-} code hash now_ms item
  code=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  hash=$(printf %s "$code" | sha)
  now_ms=$(( $(date +%s) * 1000 ))
  item="{\"pk\":{\"S\":\"I#$hash\"},\"sk\":{\"S\":\"I\"},\"kind\":{\"S\":\"$kind\"},\"createdBy\":{\"S\":\"admin\"},"
  item+="\"expiresAt\":{\"N\":\"$(( now_ms + ttl_seconds * 1000 ))\"},\"ttlEpochSeconds\":{\"N\":\"$(( now_ms / 1000 + ttl_seconds ))\"}"
  [[ -n "$user_id" ]] && item+=",\"userId\":{\"S\":\"$user_id\"}"
  aws dynamodb put-item --table-name "$table" --item "$item}"
  echo "$code"
}

case "${1:-}" in
  new)
    url=$(app_url)
    code=$(put_invite friend $(( 7 * 86400 )))
    echo "Invite link (single use, expires in 7 days):"
    echo
    echo "  $url/#join=$code"
    ;;
  device)
    user_id="${2:?usage: invite.sh device <userId>}"
    [[ "$user_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad userId" >&2; exit 1; }
    found=$(aws dynamodb get-item --table-name "$table" --key "{\"pk\":{\"S\":\"U#$user_id\"},\"sk\":{\"S\":\"P\"}}" --query Item.name.S --output text)
    [[ "$found" != "None" ]] || { echo "no user $user_id (see: invite.sh users)" >&2; exit 1; }
    url=$(app_url)
    code=$(put_invite device 900 "$user_id")
    echo "Device link for $found (single use, expires in 15 minutes):"
    echo
    echo "  $url/#device=$code"
    ;;
  users)
    aws dynamodb scan --table-name "$table" --filter-expression "sk = :p" \
      --expression-attribute-values '{":p":{"S":"P"}}' \
      --query 'Items[].[id.S, name.S]' --output text | sort -k2
    ;;
  revoke)
    user_id="${2:?usage: invite.sh revoke <userId>}"
    keys=$(aws dynamodb scan --table-name "$table" --filter-expression "sk = :t AND userId = :u" \
      --expression-attribute-values "{\":t\":{\"S\":\"T\"},\":u\":{\"S\":\"$user_id\"}}" \
      --query 'Items[].pk.S' --output text | tr '\t' '\n' | grep . || true)
    revoked_count=0
    for pk in $keys; do
      aws dynamodb delete-item --table-name "$table" --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"T\"}}"
      revoked_count=$((revoked_count + 1))
    done
    echo "signed out $revoked_count device(s) of $user_id"
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
