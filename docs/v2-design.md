# Pull-up Tracker v2: data, API and auth

Status: **draft**, revised 2026-10-12. The decisions here are expensive to reverse: data
formats, the API, auth and the social graph. What the product does with them is in
[product.md](product.md).

## Decisions at a glance

| Topic | Decision |
|---|---|
| Measures | An exercise is counted (in a unit it names: rep, step, lap, flight…) or timed (seconds). |
| Composer model | `/api/compose` → Claude Haiku 5.5 on every client. Apple's on-device model is a later cost and privacy optimization on iOS. |
| Links | A short code resolving to a stored, typed payload: `friend` or `challenge` to start. Every kind makes a friendship. New kinds are additive. |
| Leaderboard | Board specs `{ metric, exerciseId?, period }` evaluated by the client over raw day totals. The server never ranks. |
| Growth measurement | Per-link open and join counters, and `joinedVia` on the profile. No analytics vendor. |
| Domain | `pullups.haydenroszell.com` for now. Move to the final domain before anyone but the operator registers a passkey. |
| Time zone | **Per user**, stored on the profile. Replaces Denver-for-everyone. |
| Old data | A set with no `exerciseId` is a pull-up. Existing users get `America/Denver` as their zone. No migration. |
| Old clients | `/api/sync` requires `protocolVersion: 2`. Older clients get 426 until they update. |

## Data model v2

### Entry

```json
{
  "id": "9f2c…", "doneAt": 1791489600000, "updatedAt": 1791489600000,
  "exerciseId": "pull-up", "variationIds": ["wide-grip"],
  "reps": 6, "addedWeightLbs": 25
}
```

| Field | Rule |
|---|---|
| `exerciseId` | Built-in slug (`^[a-z0-9-]{1,40}$`) or a created id (`x-` + 16 base32 chars). Absent means `pull-up`. Normalization drops it when it equals `pull-up`. |
| `variationIds` | Built-in slugs or created ids (`v-` + 16 base32 chars), at most 6, unique, stored **sorted**. Absent or empty means none. |
| `reps` | Integer 1–100000, the count **in the exercise's unit** (reps, steps, laps). The name stays `reps` because it is a deployed data format. |
| `holdSeconds` | Integer 1–86400. Exactly one of `reps` and `holdSeconds` is present, and it must match the exercise's measure. |
| `addedWeightLbs` | Unchanged. Allowed on holds too. |

The bounds are wide because exercises are open: a stair session can be thousands of steps,
and a ruck can be hours. Validation rejects nonsense types, not unusual numbers.

Sorting `variationIds` matters. `["tuck","negative"]` and `["negative","tuck"]` must be the
same version, or `sameVersion` sees a change that isn't one.

**Tiebreak.** `pickWinner` must stay a total order. After `updatedAt` and `deleted`, it
compares, in order: `reps ?? 0`, `holdSeconds ?? 0`, `addedWeightLbs ?? 0`,
`exerciseId ?? "pull-up"`, `variationIds` joined with `,` (empty when absent), then
`doneAt`. Old entries carry none of the new fields, so their outcomes don't change. The
same chain is implemented in Swift and checked against shared fixtures (see Shared fixtures).

### Exercises and variations

Two sources, one shape.

**Built-ins** live in `src/shared/catalog.json`, bundled into every client and the Lambda:

```json
{
  "exercises": [
    { "id": "pull-up", "name": "Pull-up", "measure": "count", "unit": "rep", "variationGroups": ["grip", "tempo", "assistance"] },
    { "id": "front-lever", "name": "Front lever", "measure": "time", "variationGroups": ["progression"] }
  ],
  "variations": [
    { "id": "wide-grip", "name": "Wide grip", "group": "grip" },
    { "id": "tuck", "name": "Tuck", "group": "progression" },
    { "id": "negative", "name": "Negative", "group": "tempo" }
  ]
}
```

The first catalog: pull-up, chin-up, muscle-up, inverted row; push-up, dip, pike push-up,
handstand push-up; squat, pistol squat, lunge; hanging leg raise, toes-to-bar; dead hang,
plank, hollow hold, L-sit, handstand, front lever, back lever, planche. Variation groups:
grip, progression (tuck → advanced tuck → one-leg → straddle → full), tempo (negative,
pause, explosive), assistance (band, feet-assisted) and form (archer, one-arm). A built-in
variation is at most one per group.

**Created** exercises and variations are stored items, made by any user, at face value:

```json
{ "id": "x-k3p9…", "name": "Red Rocks stairs", "measure": "count", "unit": "lap",
  "description": "Full run of the amphitheatre stairs, bottom to top", "createdBy": "<userId>",
  "createdAt": 1791489600000, "updatedAt": 1791489600000 }
```

```json
{ "id": "v-8qzr…", "exerciseId": "muscle-up", "name": "Into tuck", "createdBy": "<userId>", "updatedAt": … }
```

- **Ids are made on the client**, so you can create an exercise offline and log to it
  straight away. They travel in the sync push like entries.
- **`measure` and `unit` are fixed at creation.** Changing them would change the meaning of
  every set already logged. Name and description are editable by the creator, merged
  last-writer-wins on `updatedAt`.
- **A created variation belongs to one exercise**, built-in or created, and has no group. So
  "into tuck" on a muscle-up can sit alongside "wide grip".
- **The server checks shape only**: name 1–60 printable characters, unit 1–20, description
  up to 280, measure one of `count` or `time`. It does not judge whether an exercise is
  real, sensible or a duplicate.
- **Duplicates are reduced, not prevented.** The picker and the composer search your
  exercises, your friends' and the built-ins before offering "new". Friends who adopt each
  other's exercises share one id. Merging two created exercises (an `aliasOf` pointer) is
  later work.
- **A client that meets an unknown id** fetches the definition in its next sync. Until
  then it shows "Unknown exercise".

### Day total

Still recomputed from entries on every change, and now keyed by the user's **local** day
(see Time zones):

```json
{
  "day": "2026-10-08", "reps": 61, "sets": 14, "bestSetReps": 12, "holdSeconds": 95,
  "byExercise": {
    "pull-up": { "reps": 31, "sets": 6, "bestSetReps": 8 },
    "push-up": { "reps": 30, "sets": 3, "bestSetReps": 12 },
    "x-k3p9…": { "reps": 3, "sets": 3, "bestSetReps": 1 },
    "plank": { "sets": 2, "holdSeconds": 95, "bestHoldSeconds": 60 }
  },
  "version": 7
}
```

- The top-level `reps` keeps its meaning of "the number on the ring": counted sets whose
  unit is `rep`. A created exercise counted in reps (say "archer typewriters") counts. Red
  Rocks laps don't, because a thousand steps would swamp sixty pull-ups.
- `byExercise[id].reps` is in that exercise's own unit. It feeds the per-exercise boards and
  profile totals.
- Recomputing needs each exercise's unit. Built-ins come from the bundled catalog, created
  ones from a batch get of the day's distinct `x-` ids.
- A day total written before v2 has no `byExercise`, and readers treat it as entirely
  `pull-up`. Any later edit rewrites it, so no backfill is needed.

### Time zones

Denver-for-everyone worked for one friend group in one city. Open sign-up and a growth loop
make it wrong: a friend in London would see their day roll over at 7 a.m. And the zone
decides day keys, which are stored, so it has to change **now**, before more data depends
on it.

- The profile gains `timeZone` (IANA name). It is set from the device at sign-up, editable
  in Settings, and existing users default to `America/Denver`, so their day keys don't move.
- `time.ts` takes the zone as a parameter instead of a constant. Day-key arithmetic stays
  pure calendar math.
- Changing your zone recomputes your day totals for the last 62 days. Older days keep
  their keys. That's the cost of moving, and it's rare.
- Leaderboards compare **each person's own** today, week and month. Two friends in
  different zones are on different "todays" for part of the day, which is what users
  expect.

### Profile

`U#<userId> P` gains `dailyGoalReps`, `goalUpdatedAt`, `timeZone`, `zoneUpdatedAt`, and a
`name` that is editable, merged last-writer-wins. The goal moves off the device so the
phone, Watch, widgets and the "% of goal" ranking agree on it.

It also gains `joinedVia: { kind, linkCreatedBy }`, written once at sign-up and never
edited. Absent means the account predates links.

### Links

A link is an `I#<digest>` item holding a typed payload:

```json
{ "kind": "challenge", "createdBy": "<userId>", "createdAt": 1791489600000,
  "board": { "metric": "count", "exerciseId": "x-k3p9…", "fromDay": "2026-10-01", "toDay": "2026-10-31" },
  "openCount": 14, "joinCount": 3 }
```

- **Every kind makes a friendship.** That is the one behavior all links share. The payload
  only adds a landing: a board, an adopted exercise. A client that meets a kind it doesn't
  know still makes the friendship and opens Today. So a new kind (a group challenge, an
  event) is a server change plus a client release, with no migration and no broken links
  on old clients.
- **The URL carries only the code.** What a link means lives in the item, so it can change
  without changing the URL format, and a link can be retired by deleting one item.
- **Friend links** are one per user, reusable, with no expiry, as before. **Challenge
  links** are made per challenge, reusable, and stop resolving a week after `toDay`.
- **`openCount` and `joinCount`** are atomic counters, bumped by the resolve and by a
  sign-up or friend-add through the link. With `joinedVia`, they are the whole growth
  funnel: which kinds get opened, and which turn into accounts. No analytics vendor, and
  nothing about the person opening the link is stored.

### Boards

A board is a spec the client evaluates over friends' day totals:

```json
{ "metric": "count", "exerciseId": "x-k3p9…", "period": "month" }
```

`metric` is one of `count`, `sets`, `bestSet`, `activeDays`, `goalPercent`. `period` is
`today`, `week`, `month`, or a fixed `fromDay`/`toDay` window for a challenge. Specs are a
shared TS and Swift type, pinned by fixtures (`boards.json`), and a challenge link stores
one.

The server stores totals and never ranks, so a new metric, a different default, or a tweak
to how ties break ships in a client release. The limit: a metric can only use what a day
total holds. A new day-total field (say, longest hold within a set) is additive, since
totals recompute on every change, but past days only get it through a backfill. Add the
candidates in M0, while the data is one user's.

### New items

| pk | sk | item |
|---|---|---|
| `U#<userId>` | `K#<credentialId>` | passkey: public key (COSE), sign count, transports, createdAt, label |
| `U#<userId>` | `F#<friendId>` | friendship (written on both sides in one transaction): createdAt |
| `U#<userId>` | `L` | the user's current friend-link digest, so rotating it can delete the old `I#` item. Challenge links aren't tracked here. They expire. |
| `U#<userId>` | `Q#<day>` | compose usage counter for the day, with `ttlEpochSeconds` |
| `X#<exerciseId>` | `X` | created exercise |
| `X#<exerciseId>` | `V#<variationId>` | created variation on that exercise (built-in exercises too: `X#pull-up V#v-…`) |
| `C#<digest>` | `C` | pending WebAuthn challenge: purpose, userId?, name?, expiresAt, ttlEpochSeconds |
| `I#<digest>` | `I` | gains the link kinds `friend` and `challenge`, with `createdBy`, the payload, `openCount`, `joinCount` and `ttlEpochSeconds` for challenges (see Links). `device` invites are unchanged. |

None needs a new index. Passkey login finds the credential through the `userHandle` the
authenticator returns, which is the user id. Friends are a query on `U#<userId>` with
`begins_with(sk, "F#")`. A friend's day totals are a query on `U#<friendId>` between
`D#<from>` and `D#<to>`. Exercise definitions are point gets.
`test/dynamodb.test.ts`'s `CreateTableCommand` doesn't change.

## API

Every change is additive except the protocol gate.

**Protocol gate.** `/api/sync` requires `protocolVersion: 2` in the body. Without it the
server returns 426 *Update the app*. A v1 client's `normalizeEntry` strips fields it
doesn't know, so if it edited a chin-up, its edit would win under last-writer-wins and turn
the chin-up back into a pull-up. With the gate, a stale PWA sees 426 once, and the service
worker loads the new code on its next launch.

**`POST /api/sync`**
- Request: `{ protocolVersion, pushedEntries, pushedDefinitions, sinceCursor }`.
  `pushedDefinitions` holds created exercises and variations, each merged last-writer-wins
  and rejected if a non-creator tries to change one.
- Response: as today, plus `definitions` for every created id referenced by the returned
  entries or by your adopted list. `account` gains the new profile fields.

**`POST /api/profile`**: `{ name?, dailyGoalReps?, goalUpdatedAt?, timeZone?, zoneUpdatedAt? }`,
last-writer-wins per field. Returns the stored profile.

**`POST /api/friends`**: `{}` → `{ friends: [{ id, name }], friendLink }`.
**`POST /api/friends/remove`**: `{ friendId }` deletes both sides.
**`POST /api/friends/rotate-link`**: invalidates your old link, returns a new one.

**`POST /api/links/resolve`** (unauthenticated): `{ code }` → `{ kind, inviterName, board?,
definition? }`, enough for the landing page to say what the link is. Bumps `openCount`.
Rate-limited with the sign-up endpoints.
**`POST /api/links/redeem`**: `{ code }` → `{ kind, friend: { id, name }, board?, definition? }`.
Makes the friendship, adopts the exercise for a challenge, bumps `joinCount` the first
time. Idempotent. Replaces `/api/friends/add`.
**`POST /api/challenges`**: `{ board }` → `{ link }`. The board must name an exercise you
can see.

**`POST /api/leaderboard`**: `{ fromDay, toDay }`, at most 62 days.
- Response: `{ users: [{ id, name, timeZone, dailyGoalReps, days: [DayTotal] }], definitions }`,
  for you and your friends.
- Implementation: one friends query, then one day-total query per friend, in parallel, plus
  a batch get of profiles and definitions. A cap of 200 friends keeps this bounded. The
  `by-month` GSI is no longer needed for the board. It stays for operators' cross-user
  reports.
- The client ranks, by evaluating a board spec over the response. Metrics, periods and the
  default are client decisions, and a widget can compute "you're #2 today" from the same
  response.

**`POST /api/profile/view`**: `{ userId }`, friends only → `{ profile, days (last 90),
exercises: [{ definition, totals, bests }] }`. A non-friend gets 404, not 403, so ids don't
reveal accounts.

**`POST /api/compose`** (see The composer): `{ text, nowMs, timeZone, knownExercises: [{ id, name, measure, unit }] }`
→ `{ draft }`. Authenticated, capped per user per day.

**Sign-up and passkeys** (see Auth):
- `POST /api/signup/options` `{ name, linkCode? }` → creation options for a fresh user id.
- `POST /api/signup` `{ credential, label }` → `{ token, account }`.
- `POST /api/passkey/register/options` and `/api/passkey/register` (authenticated): add
  another passkey.
- `POST /api/passkey/login/options` → request options, with no `allowCredentials`.
- `POST /api/passkey/login` `{ credential, label }` → `{ token, account }`.

**`POST /api/join` is retired.** Device links (`/api/invite {kind:"device"}` and redeeming
them) stay for the Watch and for recovery.

**`POST /api/account/delete`** deletes the whole `U#<userId>` partition and both sides of
every friendship. Created exercises stay, with `createdBy` cleared, because friends' sets
reference them. App Store guidelines require in-app deletion wherever an account can be
created.

Each new storage operation goes on `Db` and is implemented in both `MemoryDb` and `DynamoDb`,
per CLAUDE.md.

## Auth: a name and a passkey

**Why passkeys.** A passkey belongs to the domain and syncs through iCloud Keychain or
Google Password Manager. A new phone, a reinstalled app or wiped storage all sign back in
with Face ID or a fingerprint. No email or password exists to collect, leak or reset. That
matches "no real identity": the account is a display name and a key.

**Sign-up.**
1. Enter a display name (1–40 characters, not unique, editable later).
2. `/api/signup/options` makes a user id and a challenge that remembers the name and the
   link code, if any.
3. The device creates a passkey. `/api/signup` verifies it, then writes the profile (with
   `joinedVia`), the passkey and the session token in one transaction. If a link came with
   it, the same transaction redeems it: the friendship, the adopted exercise, `joinCount`.

No account exists without a passkey, so there's no half-made state to nag about.

**Signing in anywhere.** Tap **Sign in**, then Face ID. The system offers the discoverable
passkey for the domain, and `/api/passkey/login` mints a session token for this device.
There's no username field.

**Sessions.** The existing `T#<digest>` device tokens are reused as session tokens.
Revocation (`invite.sh revoke`) also deletes the user's `K#` items.

**Recovery.** No email means no "forgot password". Passkeys sync, so losing one device loses
nothing. Someone who loses every device *and* their password manager can get a device link
from another signed-in device, if they have one. Otherwise the account is gone. That's an
honest trade for collecting nothing, and the app says so at sign-up.

**Abuse.** Open sign-up on a Lambda invites junk accounts. They are harmless to users,
since nobody sees an account they didn't friend, but they cost storage.
- A CloudFront/WAF rate rule on `/api/signup*` and `/api/links/resolve` per IP.
- An account with no entries and no friends after 30 days is deleted by a scheduled sweep.

**Challenges** are 32 random bytes, stored as `C#<sha256>` with a 5-minute expiry, consumed
with a conditional delete so one can't be replayed. **Verification** uses
`@simplewebauthn/server`, attestation `none`.

**The domain is the anchor.** Every passkey is bound to the relying-party id, the app's
custom domain. Changing it later strands every credential. Until the final domain is
bought, the app runs on `pullups.haydenroszell.com`. That's fine while the operator is the
only account: moving means re-registering one passkey. **Move to the final domain before
anyone else signs up.** The custom domain (already supported in `infra/`) becomes a
requirement.

**Associated Domains (iOS).** The site serves `/.well-known/apple-app-site-association`
(`application/json`, no redirect) with `webcredentials` and `applinks` entries. The app
declares `webcredentials:<domain>` and `applinks:<domain>`. Links keep the code in
the fragment (`#join=<code>`) so it never reaches CloudFront logs. AASA `components` can
match a fragment. Verify on a device early. The fallback is a "Paste link" field.

**Android.** The PWA in Chrome uses passkeys on the same domain with no extra setup. A
native Android app would need a Digital Asset Links file. Not needed yet.

**Not Sign in with Apple.** It would add an identity to link to. Passkeys are not
third-party login, so the App Store rule requiring Sign in with Apple doesn't apply.

## The composer

The composer turns text into a draft session. It never writes data. The client shows the
draft and logs what you confirm.

### One output shape

Every client calls `/api/compose`, and the output shape is a contract independent of the
model, so the on-device model can slot in later behind the same draft UI:

```json
{
  "sets": [
    { "exercise": "Red Rocks stairs", "variations": [], "reps": 1, "repeat": 3, "minutesAgo": 0 },
    { "exercise": "Push-up", "variations": [], "reps": 20, "repeat": 3, "minutesAgo": 0 },
    { "exercise": "Front lever", "variations": ["Tuck"], "holdSeconds": 45, "repeat": 1, "minutesAgo": 0 }
  ],
  "newExercises": [
    { "name": "Red Rocks stairs", "measure": "count", "unit": "lap",
      "description": "Run of the Red Rocks amphitheatre stairs" }
  ]
}
```

**The model names things. It doesn't pick ids.** Resolving "push ups" to `push-up`, or
"red rocks" to your friend's `x-k3p9…`, is deterministic code in `PullupCore` and
`src/shared/`: normalized-name match against the known list, then an edit-distance
threshold, then "new". That keeps both models' jobs small, keeps the ids out of the model's
reach, and makes resolution testable with fixtures. `repeat` expands into individual sets,
spaced a second apart so their order survives.

### Haiku, on every client

One model means one prompt, one eval loop and no availability branching, before it's
known whether people use Describe at all.

`/api/compose` calls **Claude Haiku 5.5** (`claude-haiku-5-5`) from the Lambda with
**structured outputs** (`output_config.format` with a JSON schema, via the TypeScript SDK's
`messages.parse`), so the response always matches the shape.

- **The API key** lives in SSM Parameter Store (SecureString) and is read at cold start.
  It never reaches a client.
- **Prompt:** a fixed system prompt with the schema rules and a few worked examples
  (cacheable), then the user's text, local time and known-exercise names.
- **Cost:** roughly 2,000 input and 300 output tokens a call, at $0.10 / $0.50 per million
  tokens. About $0.0004 a call, so $0.40 per thousand. A free app can carry that.
- **Caps:** 30 composes per user per local day (the `Q#<day>` counter), and a monthly
  spend ceiling set in config. Past the ceiling, the endpoint answers 503 *Describe is
  resting, use the pad*. The pad always works.
- **Failure:** a refusal, a timeout (5 s budget) or an invalid draft shows "Couldn't read
  that" with the text kept, and the pad underneath.
- **Privacy:** the text goes to Anthropic's API. No name or user id is sent with it. On
  iOS, the first use asks for consent, because App Review requires disclosure of sending
  user content to a third-party AI service.

### Later: on-device on iOS

Apple's Foundation Models framework (iOS 26) runs a small model on the device, with
guided generation: a `@Generable` Swift struct constrains the output to the shape above.
It is free, private and offline. It needs Apple Intelligence (iPhone 15 Pro or later) and
has a small context window (about 4,000 tokens), so its prompt would carry only your 40
most-used exercise names. Worth adding if compose spend matters or people ask for offline
Describe. `/api/compose` stays the fallback.

### Evaluation

`test/fixtures/compose/` holds descriptions and their expected drafts: plain ("4x8 wide
pull-ups"), mixed sessions, holds, relative times, unknown exercises, and junk input that
should return an empty draft. The resolver is tested on them in both languages. The Haiku
prompt is checked against them by a script run manually, not in CI, because every run
costs money.

## Shared fixtures

Merge rules, day keys, stats, boards and name resolution exist in TypeScript (server and
PWA) and, from M3, in Swift. Behavior is pinned by **shared JSON fixtures** in
`test/fixtures/`, and every suite that implements them runs every case:

- **`merge.json`**: pairs of versions and the expected winner, including every tiebreak
  step and v1 → v2 shapes.
- **`days.json`**: instants, zones and their day key: Denver, London, Sydney and Kolkata,
  both DST transitions, midnight crossovers, month and year edges. Wall-clock → instant
  cases too.
- **`validation.json`**: valid and invalid entries and definitions.
- **`stats.json`**: an entry history, a zone, a "now", and the expected stats.
- **`boards.json`**: board specs, friends' day totals and the expected ranking, including
  ties, missing days and goal-less users.
- **`compose/`**: drafts and the known-exercise lists they resolve against.

The TS suites already contain most of the merge and day cases inline. M0 lifts them into
fixtures.

## Risks

| Risk | Mitigation |
|---|---|
| Passkeys bound to the wrong domain | Only the operator registers on the interim domain. Move to the final domain before links go out (the M2 checkpoint). |
| A stale client strips v2 fields | The protocol gate (see API). |
| A board metric needs data day totals don't hold | Add candidate fields in M0, while there is one user. Later fields need a backfill. |

## Alternatives considered

- **The model choosing exercise ids.** Fewer moving parts, but ids are opaque strings a
  small model gets wrong, and the on-device model's context can't hold every id.
- **The on-device model first on iOS.** Free, private and offline, but it means two
  models, two eval loops, a fallback and availability branching before anyone has used
  Describe. Haiku at the daily cap costs little. Kept as a later optimization.
- **Link parameters in the URL** (`#friend=<code>&x=<exerciseId>`). Simpler, but the URL
  format becomes a contract with every link already shared, and there's nowhere to count
  opens. A stored payload can change meaning and be retired.
- **Server-ranked leaderboards.** Smaller responses, but every ranking change becomes an
  API change. Friend counts are small, so the client ranks.
- **CloudKit instead of AWS.** Cross-user queries are awkward in CloudKit, it has no
  Android story, and it would discard a working backend.
