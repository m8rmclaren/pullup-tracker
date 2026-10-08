# Pull-ups

A personal pull-up log built for one-handed, one-tap use on a phone. Tap the number you just
did; the day's total updates instantly and syncs in the background. Daily totals, streaks and
trends live one tab over.

<p>
  <img src="docs/today.png" width="200" alt="Today: ring with today's total, set chips, quick-add pad">
  <img src="docs/edit.png" width="200" alt="Editing a set">
  <img src="docs/trends.png" width="200" alt="Trends: stat tiles and 30-day chart">
  <img src="docs/offline.png" width="200" alt="Offline: tap still counts, queued for sync">
</p>

```
 phone / laptop (PWA)                         AWS
┌──────────────────────┐   HTTPS   ┌────────────────────────┐   OAC    ┌──────────────────┐
│ Preact app           │──────────▶│ CloudFront             │─────────▶│ S3: site bucket  │
│ localStorage replica │  /*       │  security headers      │          └──────────────────┘
│ outbox + sync loop   │           │                        │ OAC/SigV4┌──────────────────┐   ┌──────────────────────┐
│ service worker       │──────────▶│  /api/*  (no cache)    │─────────▶│ Lambda (Function │──▶│ S3: data bucket      │
└──────────────────────┘ /api/sync └────────────────────────┘          │ URL, AWS_IAM)    │   │ months/2026-10.json… │
   X-Pullup-Token header                                               └────────┬─────────┘   │ (versioned)          │
                                                                                │             └──────────────────────┘
                                                                                ▼
                                                                       SSM: token digests
```

## Deploy

Deploys run from GitHub Actions (`.github/workflows/pipeline.yml`). Every push and PR runs
typecheck, tests, the build, and `terraform validate`. Every push to `main` then runs
`terraform apply`, uploads the site and invalidates CloudFront. No AWS keys are stored in
GitHub. The workflow assumes an IAM role through GitHub's OIDC token, and that role trusts
only `main` of this repo.

### One-time setup (about 5 minutes)

**1. Bootstrap AWS.** This creates the OIDC trust, the deploy role and the Terraform state
bucket from `infra/bootstrap.yaml`. Do it in **AWS CloudShell**, in the region you want
the app in:

```sh
# Upload infra/bootstrap.yaml via CloudShell's Actions → Upload file, then:
aws cloudformation deploy --stack-name pullups-bootstrap \
  --template-file bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-stacks --stack-name pullups-bootstrap \
  --query 'Stacks[0].Outputs' --output table
```

(Or use the console: CloudFormation → Create stack → Upload `infra/bootstrap.yaml`, and
tick the IAM acknowledgement.) If the account already has a GitHub OIDC provider, add
`--parameter-overrides CreateOidcProvider=false`. If you rename the repo, also pass
`GitHubOwner=… GitHubRepo=…`.

**2. Add three repository variables.** In the repo, go to Settings → Secrets and variables
→ Actions → **Variables**. These are not secrets; none of them grants access by itself.

| Variable | Value (from the stack outputs) |
|---|---|
| `AWS_ROLE_ARN` | `AwsRoleArn` |
| `AWS_REGION` | `AwsRegion` |
| `TF_STATE_BUCKET` | `TfStateBucket` |

**3. Deploy.** Actions → pipeline → **Run workflow** (or push to `main`). The run summary
prints the app URL. Until the variables exist, the deploy job is skipped, not failed.

**4. Make a token.** In CloudShell, upload `scripts/token.sh` and run `bash token.sh new`.
Open the app URL on your phone, tap **Set up sync**, and paste the token. Then use
**Share → Add to Home Screen** (iOS) or **Install app** (Android/Chrome). Repeat the paste
on each device; one shared token or one per device both work.

After that, merging to `main` is the deploy. Installed apps pick up a new version on their
next launch.

### What the CI role can do

The deploy role (`github-deploy-pullups`) can only touch resources named `pullups-*`
(buckets, Lambda, log group, SSM parameter) plus CloudFront, which has no useful
resource-level scoping. It can create IAM roles only when they carry the
`pullups-lambda-boundary` permissions boundary. The boundary caps any role it creates at
what the API Lambda needs: read/write `months/*`, read the token parameter, and write logs.
Without the boundary, "can create a role and a Lambda" amounts to "can become admin". The
role's own name sits outside the `pullups-*` namespace, so it cannot edit itself.

The data bucket has `prevent_destroy` in Terraform, so a bad change can't plan it away.

### Deploying from a laptop instead

```sh
export AWS_REGION=us-west-2 TF_STATE_BUCKET=<TfStateBucket output>   # plus AWS credentials
scripts/deploy.sh            # check, build, terraform apply, upload, invalidate
scripts/deploy.sh --site     # skip terraform; just rebuild and upload the site
```

This uses the same remote state as CI, so the two never disagree.

**Custom domain** (optional): the domain's zone must be a Route 53 public hosted zone, with
its name servers set at the registrar. Set the repository variables `DOMAIN_NAME` (e.g.
`pullups.example.com`) and `DNS_ZONE_NAME` (`example.com`), and pass the matching
`DnsZoneId` and `DomainName` to the bootstrap stack so the deploy role may edit just those
records. Terraform then issues the us-east-1 ACM certificate, validates it through DNS, and
points A/AAAA alias records at the distribution. Locally, pass the same two values as `-var`s.

## How auth works

There are two independent locks on the API, and no AWS credential ever reaches a browser:

1. **Only CloudFront can call the Lambda.** The Function URL uses `AWS_IAM` auth, and the
   only principal allowed to invoke it is the CloudFront distribution, which signs each
   request with SigV4 through Origin Access Control. Hitting the raw `*.lambda-url…` host
   directly returns 403. (For POST bodies OAC needs the payload hash, so the client sends
   `x-amz-content-sha256`; that's computed with WebCrypto and isn't a secret.)
2. **Only you can get past the Lambda.** Every request carries `X-Pullup-Token`, a
   256-bit random token. The Lambda hashes it and compares it in constant time against
   the SHA-256 digests in the SSM parameter `/pullups/token-hashes`. The token is never
   in the bundle, the repo, or AWS; it exists only in your devices' storage and in the
   one-time output of `token.sh new`.

A custom header is used instead of `Authorization` because OAC replaces `Authorization`
with its own signature on the way to the origin.

The site bucket and data bucket are both fully private (Block Public Access, owner-enforced
objects). The Lambda's role can only Get/Put `months/*` in the data bucket, List under that
prefix, and read the one SSM parameter.

### Rotating or revoking the token

Run these from AWS CloudShell (upload `scripts/token.sh`) or anywhere else that has AWS credentials.
They need only the AWS CLI and openssl.

```sh
scripts/token.sh new             # add a new token; old ones keep working
#   …paste the new token into Settings on each device…
scripts/token.sh list            # see valid digests
scripts/token.sh revoke 3fa9c1   # revoke the old one by digest prefix
scripts/token.sh revoke-all      # lost a phone? kill everything, then `new`
```

Changes take effect within 60 seconds (the Lambda caches the digest list for a minute).
No redeploy is needed. A device holding a revoked token shows **Token rejected**; it keeps
logging locally and syncs once you paste a valid token.

## Data layout and sync

**One JSON file per Denver calendar month:** `s3://<data-bucket>/months/2026-10.json`,
holding `{ v: 1, entries: [...] }`. Each entry is one set:

```json
{ "id": "9f2c…", "ts": 1791489600000, "reps": 6, "updatedAt": 1791489600000 }
```

`ts` is when you did the set (it decides the day). `updatedAt` is the version clock.
A deleted set stays as a tombstone with `"deleted": true` so the delete itself can sync.

**No lost writes, by construction.** The entry set is a state-based CRDT: per-entry
last-writer-wins with a deterministic tiebreak (delete beats edit on a same-millisecond tie).
Merging is commutative, associative and idempotent, so devices converge regardless of
order, duplicates or retries. On the server, the Lambda merges a push into the month file
with an **S3 conditional write** (`If-Match` on the ETag, or `If-None-Match: *` to create).
If another request wrote first, S3 answers 412, and the Lambda re-reads, re-merges and
retries. Two phones syncing at the same instant, or ten fast taps in flight, cannot
overwrite each other. A test fires 12 concurrent pushes through an interleaving store to
prove it, and it fails if the conditional write is removed.

**One endpoint.** `POST /api/sync { push: Entry[], have: { "2026-10": "<etag>", … } }`
pushes the outbox and returns only the months whose ETag differs from what the client
already has. A no-change sync is one `LIST` plus nothing else, and a fresh device gets
everything in one round trip.

Month files stay small (~6 sets/day ≈ 15 KB/month), so whole-file rewrites are cheap.
The bucket is **versioned**, with superseded versions kept 90 days, as a manual escape hatch.

## Offline behavior

- **Every tap is local first.** The entry is written to the in-memory replica and
  `localStorage` synchronously, added to the outbox, and rendered. The network is never
  on the tap path.
- **Taps are batched.** A sync fires 1.2 s after the last change, so a burst of edits is one request.
- **Retries back off** at 2 s, 4 s, 8 s and so on, capped at 5 minutes. A sync is also
  kicked when the app comes to the foreground, when the browser reports `online`, and
  every minute while visible. iOS has no Background Sync API, so these opportunistic
  triggers are what it gets.
- **Edits made during an in-flight sync stay queued.** An entry leaves the outbox only
  if the version the server acknowledged is still the latest local one.
- **The app shell is precached** by a small hand-written service worker, so the app opens
  with no signal at all. The `/api` path is never cached.
- The pill in the top right always says where things stand: *Synced*, *3 pending*,
  *Offline · 3*, *Token rejected*, or *Set up sync*.

If `localStorage` is wiped (or you sign in on a new device), pasting the token pulls the
full history back from S3. Anything that never synced before the wipe is gone, which is
why the outbox count is always visible.

## Design decisions

**Lambda Function URL + token, not Cognito.** Cognito with an identity pool would mean
shipping a user-pool client, handling refresh tokens, and writing an IAM policy scoped to an
S3 prefix that still allows clobbering the whole month file. A single user doesn't need
any of that. A Function URL behind CloudFront OAC costs nothing idle, keeps the API
same-origin (no CORS), and puts all merge logic server-side where conditional writes make
it race-free. The browser never touches S3 directly, so it can never write a malformed or
partial file.

**Month files, not one object per set.** One-object-per-event is trivially race-free but
makes every read a LIST plus thousands of GETs within a year. A single all-time file is one
GET but gets bigger and more contended forever. Monthly files keep reads tiny and
incremental (ETags per month) and contention local, and conditional writes remove the
race that usually rules out read-modify-write.

**Days are computed in America/Denver everywhere**, regardless of the device's zone, via
`Intl.DateTimeFormat`. Day keys are `YYYY-MM-DD` strings with pure calendar arithmetic, so
the 23- and 25-hour DST days count as one day each. Sets entered by hand
(“Other amount or time…”) take a Denver wall-clock time. A time skipped by spring-forward
moves an hour later, and the repeated fall-back hour resolves to its first occurrence. The
UI rolls over at local midnight even if the app is left open.

**Preact (~4 KB gz) rather than vanilla or React.** The UI has several views, sheets and
derived stats that re-render together. Preact gives components and hooks for the price of
a small image. Bundled with **esbuild**: one dependency, a 40 KB JS / 14 KB CSS build, no
config files.

**Hand-rolled SVG charts, no chart library.** Two charts don't justify a 60+ KB dependency.
The bar chart shows daily totals with the goal as a dashed rule and a 7-day trailing mean
as a line. Tap any bar for a readout, with a legend because there are three marks. The
heatmap uses one sequential blue ramp, bucketed by fraction of your goal, so its colors
mean the same thing however your volume grows.

**Logging UX.**
- **Six big buttons for 3–8** in the bottom thumb zone, since that covers your range.
  Your most frequent count over the last 30 days is highlighted as **usual**.
- **One tap = one logged set**, with haptic feedback where supported and an **Undo**
  toast for 5 seconds.
- **A second tap within 600 ms is ignored.** A real set takes longer than that; a
  fat-finger double-tap doesn't.
- **"Other amount or time…"** opens a stepper with any rep count plus a date/time, for
  odd sets or ones you forgot to log.
- **Tap any of today's set chips to edit or delete it.** Delete has its own undo.
  Past days are editable from **Trends → History**.

**Stats shown.** Today's total against the goal ring is the headline, with set count and
current streak under it. Trends has:
- **Streak**: consecutive days with any sets, plus days at goal. An empty *today* doesn't
  break the streak until midnight.
- **7- and 30-day averages over completed days.** Today's partial total would drag them
  down all morning. Days before your first set aren't counted, so averages are honest from
  day one.
- **This week vs. last week to the same weekday.** Monday to Thursday is compared with
  last Monday to Thursday, not the whole of last week.
- **Best day**, **average set size**, **goal days out of 30**, and **lifetime totals**.
- **A 30/90-day chart, a 26-week heatmap, and a tappable 30-day history list.** The list
  doubles as the accessible table view of the chart data.

**Daily goal is per-device** (default 35). Syncing it would need a second LWW record and
a settings file. It's a one-time setting, so that wasn't worth the extra moving parts.

**Dark-first** (gym lighting, OLED), with a light theme that follows the OS. System
rounded font with tabular numerals, so digits don't jump as totals change.

**Cost.** Effectively zero at this volume. A few hundred Lambda invocations and S3
requests a day sit inside the free tiers, and the SSM standard parameter is free.
CloudFront's always-free tier covers it. To bound worst-case cost from someone hammering
the URL with bad tokens, set `lambda_reserved_concurrency` (e.g. `2`). It defaults to off
because new AWS accounts often can't reserve concurrency.

## Development

```sh
npm install
npm run dev        # builds, then serves on http://localhost:5173 with the real sync handler
                   # over a file-backed store in .devdata/ — token: dev-token-change-me
npm test           # vitest
npm run typecheck
npm run check      # both
npm run build      # dist/site (static) + dist/lambda/index.js
```

The service worker is skipped on `localhost` so dev reloads aren't served stale.
`scripts/make-icons.py` regenerates the PNG icons (needs Pillow).

### Tests

- `test/time.test.ts`: Denver day boundaries in both offsets, evening sessions that cross
  UTC midnight, month and year edges, both DST transitions, wall-clock → instant conversion.
- `test/stats.test.ts`: daily totals with tombstones, zero-filling, streak rules,
  completed-day averages, week-to-date comparison, best day, empty history.
- `test/model.test.ts`: LWW tiebreaks, commutativity/associativity/idempotence, an edit
  that moves a set across a month boundary, input validation.
- `test/server-sync.test.ts`: month partitioning, ETag-based incremental pulls, **12
  concurrent writers losing nothing**, concurrent edit vs. delete, auth with overlapping
  rotated tokens, and bad input.
- `test/tracker.test.ts`: the client replica. It covers persistence before network,
  debounced batching, an edit during an in-flight push, two devices converging after
  offline edit/delete conflicts, a fresh device pulling history, undo before first sync,
  backoff, and stopping on a rejected token.
- `test/handler.test.ts`: the Lambda entrypoint. It covers Function URL events, base64
  bodies, and SSM digest caching.

## Layout

```
src/shared/   time.ts (Denver calendar), model.ts (entries + CRDT merge), stats.ts
src/lambda/   handler.ts → http.ts (route/auth) → sync.ts (conditional-write merge) → s3store.ts
src/app/      tracker.ts (local replica + sync engine), api.ts, App/Today/Trends/sheets/charts, sw.ts
src/dev/      local server used by `npm run dev`
infra/        Terraform: buckets, CloudFront + OACs, Lambda + URL, SSM parameter
              bootstrap.yaml: one-time CloudFormation for CI (OIDC role, state bucket, boundary)
scripts/      build.mjs, dev.mjs, deploy.sh, tf-init.sh, publish-site.sh, token.sh, make-icons.py
.github/      pipeline.yml: check on every push/PR, deploy on main
```
