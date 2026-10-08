#!/usr/bin/env bash
# Admin access to accounts. Day to day, people invite each other from Settings in the app;
# this is for the first invite, recovering a lost account, and revoking access.
#
#   scripts/invite.sh new            print a single-use invite link for a new person (7 days)
#   scripts/invite.sh device <uid>   print a link that signs a device into <uid> (15 min)
#   scripts/invite.sh users          list accounts
#   scripts/invite.sh revoke <uid>   sign every device of <uid> out (takes effect within a minute)
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

# put_invite <kind> <ttl-seconds> [uid]
put_invite() {
  local kind=$1 secs=$2 uid=${3:-} code hash now_ms item
  code=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  hash=$(printf %s "$code" | sha)
  now_ms=$(( $(date +%s) * 1000 ))
  item="{\"pk\":{\"S\":\"I#$hash\"},\"sk\":{\"S\":\"I\"},\"kind\":{\"S\":\"$kind\"},\"by\":{\"S\":\"admin\"},"
  item+="\"expiresAt\":{\"N\":\"$(( now_ms + secs * 1000 ))\"},\"ttl\":{\"N\":\"$(( now_ms / 1000 + secs ))\"}"
  [[ -n "$uid" ]] && item+=",\"uid\":{\"S\":\"$uid\"}"
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
    uid="${2:?usage: invite.sh device <uid>}"
    [[ "$uid" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad uid" >&2; exit 1; }
    found=$(aws dynamodb get-item --table-name "$table" --key "{\"pk\":{\"S\":\"U#$uid\"},\"sk\":{\"S\":\"P\"}}" --query Item.name.S --output text)
    [[ "$found" != "None" ]] || { echo "no user $uid (see: invite.sh users)" >&2; exit 1; }
    url=$(app_url)
    code=$(put_invite device 900 "$uid")
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
    uid="${2:?usage: invite.sh revoke <uid>}"
    keys=$(aws dynamodb scan --table-name "$table" --filter-expression "sk = :t AND uid = :u" \
      --expression-attribute-values "{\":t\":{\"S\":\"T\"},\":u\":{\"S\":\"$uid\"}}" \
      --query 'Items[].pk.S' --output text | tr '\t' '\n' | grep . || true)
    n=0
    for pk in $keys; do
      aws dynamodb delete-item --table-name "$table" --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"T\"}}"
      n=$((n + 1))
    done
    echo "signed out $n device(s) of $uid"
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
