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

Prerequisites: Node 22+, Terraform ≥ 1.6, the AWS CLI logged in to the target account.

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars   # optional: region, custom domain
scripts/deploy.sh                                          # test, build, terraform apply, upload, invalidate
scripts/token.sh new                                       # prints your token once
```

Open the printed URL on your phone, tap **Set up sync**, paste the token, then
**Share → Add to Home Screen** (iOS) or **Install app** (Android/Chrome). Repeat the
token paste on each device; you can use the same token everywhere or one per device.

Subsequent deploys: `scripts/deploy.sh` again, or `scripts/deploy.sh --site` to skip
Terraform when only the frontend changed. Installed apps pick up a new version on their
next launch after the deploy.

Terraform state is local (`infra/terraform.tfstate`, gitignored). That's fine for a
one-person project; keep a copy somewhere safe or add an S3 backend block if you prefer.

**Custom domain** (optional): request an ACM certificate for it in **us-east-1**, set
`domain_name` and `acm_certificate_arn` in `terraform.tfvars`, deploy, then point a
CNAME/alias at the distribution.

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
scripts/      build.mjs, dev.mjs, deploy.sh, token.sh, make-icons.py
```
