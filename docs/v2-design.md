# Pull-up Tracker v2: data, API and auth

Status: **draft**, revised 2026-10-12. The decisions here are expensive to reverse: data
formats, the API, auth and the social graph. What the product does with them is in
[product.md](product.md).

## Decisions at a glance

| Topic | Decision |
|---|---|
| Measures | An exercise is counted (in a unit it names: rep, step, lap, flight…) or timed (seconds). |
| Composer model | `/api/compose` → Claude Haiku 5.5 on every client. Apple's on-device model is a later cost and privacy optimization on iOS. |
| Links | A short code resolving to a stored, typed payload: `friend` or `challenge` to start. Every kind makes a friendship with whoever shared it. New kinds are additive. |
| Friend requests | To anyone you share a challenge with. Accepted in one tap, mutual requests befriend at once, declines are silent and final. |
| Challenges | A stored group: one exercise, a window of at most 62 days, an optional target. Members see each other's totals for that exercise in that window, and nothing else. Every member has their own link. |
| Leaderboard | Board specs `{ metric, exerciseId?, period }` evaluated by the client over raw day totals. The server never ranks. A challenge board adds the group total toward the target. |
| Growth measurement | Per-link open and join counters, and `joinedVia` on the profile. No analytics vendor. |
| Domain | `pullups.haydenroszell.com` for now. Move to the final domain before anyone but the operator registers a passkey. Sign-up stays closed (`signup_open`) until then. |
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
| `exerciseId` | Built-in slug (`^[a-z0-9-]{1,40}$`, present in the bundled catalog) or a created id (`x-` + 16 lowercase base32 chars, `a-z2-7`). Absent means `pull-up`. Normalization drops it when it equals `pull-up`. |
| `variationIds` | Built-in slugs (in the catalog) or created ids (`v-` + 16 lowercase base32 chars), at most 6, unique, stored **sorted**. Absent or empty means none. |
| `reps` | Integer 1–100000, the count **in the exercise's unit** (reps, steps, laps). The name stays `reps` because it is a deployed data format. |
| `holdSeconds` | Integer 1–86400. Exactly one of `reps` and `holdSeconds` is present, and it must match the exercise's measure. |
| `addedWeightLbs` | Unchanged. Allowed on holds too. |

The bounds are wide because exercises are open: a stair session can be thousands of steps,
and a ruck can be hours. Validation rejects nonsense types, not unusual numbers.

Validation (pinned by `validation.json`) also checks what the bundled catalog can decide: a
built-in `exerciseId` must be in the catalog and its measure must match (`reps` for
`count`, `holdSeconds` for `time`), and built-in variations are at most one per group. No
built-in slug starts with `x-` or `v-`, so an id's prefix alone says whether it is
created. A created exercise's measure needs its definition, so only the server checks it.
An unknown built-in id is rejected rather than stored, so **a new built-in ships to the
server before any client that logs it**.

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
  real, sensible or a duplicate. Text must already be trimmed and free of control and
  format characters (`validation.json`), so clients clean it before saving.
- **The server stamps `createdBy`** from the account that first pushes the id; a
  client-sent `createdBy` is ignored. A later push by anyone else, or one that changes
  `measure`, `unit` or a variation's `exerciseId`, is **dropped and logged rather than
  rejected**, so one bad definition can't wedge the rest of a client's outbox.
- **A set's measure must match its created exercise** (`reps` for `count`, `holdSeconds`
  for `time`), checked after the push's definitions are merged. A set that logs to an
  unknown created id is accepted, so no write is ever lost to ordering.
- **Your adopted list** is what every sync returns: one `U#<userId> A#<key>` item per
  definition you created or have logged to (see New items). Creating a definition adopts
  it in the same transaction; pushing a set that logs to someone else's adopts it then.
  M1's challenge join and M2's Add to mine will write the same item. Each sync returns
  every adopted definition, so a rename reaches every device on its next sync, at the
  cost of one query and one batch get per sync.
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
    "pull-up": { "reps": 31, "sets": 6, "bestSetReps": 8, "bestAddedWeightLbs": 25 },
    "push-up": { "reps": 30, "sets": 3, "bestSetReps": 12 },
    "x-k3p9…": { "reps": 3, "sets": 3, "bestSetReps": 1 },
    "plank": { "sets": 2, "holdSeconds": 95, "bestHoldSeconds": 60 }
  },
  "version": 7
}
```

- The top-level `reps` keeps its meaning of "the number on the ring": counted sets whose
  unit is `rep`. `bestSetReps` follows the same rule. `sets` counts every set, and
  `holdSeconds` sums every hold. A created exercise counted in reps (say "archer typewriters") counts. Red
  Rocks laps don't, because a thousand steps would swamp sixty pull-ups.
- `byExercise[id].reps` is in that exercise's own unit. It feeds the per-exercise boards and
  profile totals. A counted exercise has `sets`, `reps`, `bestSetReps`; a timed one has
  `sets`, `holdSeconds`, `bestHoldSeconds`. Either has `bestAddedWeightLbs` when any set
  that day carried weight, the one candidate field added for a future "heaviest set" board.
- The board metrics read: `count` → `reps` or `holdSeconds`; `sets` → `sets`; `bestSet` →
  `bestSetReps` or `bestHoldSeconds`; `activeDays` → `sets > 0`; `goalPercent` → the
  top-level `reps` against the profile's goal. Each is per exercise in `byExercise`, or
  across exercises at the top level.
- The shape is computed by `computeDayTotal` in `src/shared/stats.ts` and pinned by
  `stats.json` (`dayTotalRecords`), so a client can recompute a day exactly as the server
  does.
- Recomputing needs each exercise's unit. Built-ins come from the bundled catalog, created
  ones from a batch get of the day's distinct `x-` ids.
- A day total written before v2 has no `byExercise` or `holdSeconds`, and readers treat it
  as entirely `pull-up` (`exerciseDayTotals`, pinned by `stats.json`'s `legacyDayTotals`).
  The test suite checks, for every day of the v1 golden history, that this reading equals a
  v2 recompute of the same sets. Any later edit to the day rewrites it, so no backfill is
  needed. The one thing a v1 total can't say is its `bestAddedWeightLbs`.

### Time zones

Denver-for-everyone worked for one friend group in one city. Open sign-up and a growth loop
make it wrong: a friend in London would see their day roll over at 7 a.m. And the zone
decides day keys, which are stored, so it has to change **now**, before more data depends
on it.

- The profile gains `timeZone` (IANA name). It is set from the device at sign-up, editable
  in Settings, and existing users default to `America/Denver`, so their day keys don't move.
  The default is applied at read time: a profile with no `timeZone` means Denver, so no
  backfill. Sign-up takes the device's `timeZone` for the new account (absent means
  Denver).
- A client that hasn't joined an account keeps days in the device's own zone. Once
  signed in, it uses the account's zone, from the sync response.
- `time.ts` takes the zone as a parameter instead of a constant. Day-key arithmetic stays
  pure calendar math.
- Changing your zone recomputes your day totals for the last 62 days. Older days keep
  their keys. That's the cost of moving, and it's rare. The window reaches two days past
  each end, since two zones' todays can be up to two dates apart (UTC+14 vs UTC−12), and a
  day with no sets gets no total rather than an empty one. The rebuild runs whenever a
  request's zone is the stored one afterwards, so a client retrying a change whose first
  attempt died mid-rebuild heals it. A sync that read the old zone and is still running
  can write one day in the old zone; the next edit to that day fixes it.
- Leaderboards compare **each person's own** today, week and month. Two friends in
  different zones are on different "todays" for part of the day, which is what users
  expect.

### Profile

`U#<userId> P` gains `dailyGoalReps`, `goalUpdatedAt`, `timeZone`, `zoneUpdatedAt`, and a
`name` that is editable, merged last-writer-wins with its own clock, `nameUpdatedAt`. Each
field is a separate register, so a goal set on the phone and a zone set on the laptop both
survive (`merge.json`'s `profiles`). A field with no clock was set at sign-up, or predates
clocks, and loses to any edit. The goal moves off the device so the phone, Watch, widgets
and the "% of goal" ranking agree on it. Until an account's goal is first set, each device
keeps showing its own, so nobody's ring moves on upgrade.

The profile also gains a `version`, bumped on every edit, and edits are a read, a merge and
a put conditional on it. (The API role may put but not update items, so a put must carry
every profile attribute.) A profile never edited since sign-up has no version.

It also gains `joinedVia: { kind, linkCreatedBy }`, written once at sign-up and never
edited. Absent means the account predates links.

### Links

A link is an `I#<digest>` item holding a typed payload:

```json
{ "kind": "challenge", "createdBy": "<userId>", "createdAt": 1791489600000,
  "challengeId": "g-7mfa…", "openCount": 14, "joinCount": 3 }
```

- **Every kind makes a friendship** with the link's creator. That is the one behavior all
  links share. The payload only adds a landing: a challenge, an adopted exercise. A client that meets a kind it doesn't
  know still makes the friendship and opens Today. So a new kind (a group challenge, an
  event) is a server change plus a client release, with no migration and no broken links
  on old clients.
- **The URL carries only the code.** What a link means lives in the item, so it can change
  without changing the URL format, and a link can be retired by deleting one item.
- **Friend links** are one per user, reusable, with no expiry, as before. **Challenge
  links** are one per member per challenge, reusable, and stop resolving a week after
  `toDay`. Each member shares their own, so the friendship goes to whoever shared it and
  the counters say which members bring people in.
- **`openCount` and `joinCount`** are counters, bumped by the resolve and by a sign-up or
  redeem through the link that made something new. With `joinedVia`, they are the whole
  growth funnel: which kinds get opened, and which turn into accounts. No analytics vendor,
  and nothing about the person opening the link is stored.
- **Counters without `UpdateItem`.** The API role may put but not update, so a bump is a
  read and a put conditional on the link's `version`, retried a few times. It is best
  effort and runs **after** the redeem or sign-up transaction, not inside it: a counter is
  analytics, and contention on it must never fail a sign-up. A bump that loses three races
  in a row is dropped and logged.
- **Codes are 128 bits** (22 base64url characters), shorter than a token for something
  people share, and still unguessable, which matters because redeeming one makes a
  friendship.
- **The owner's copy of a code is readable.** `I#<digest>` is the lookup, as for every
  secret, but the user's `L` item (and, for challenges, their membership) also holds the
  code itself, because every device must be able to show "your link" and a code can't be
  rebuilt from its digest. A link is shareable by design, so a leaked code's worst case is
  a friendship its owner sees and can remove, and anyone holding a table backup already
  sees what that friendship would show. Session tokens stay digest-only.
- An `I#` item of kind `friend` with `expiresAt` and no `openCount` is a single-use friend
  invite from before passkeys. It is not a link, and resolving or redeeming it answers 404.

### Challenges

A challenge is a group around one exercise, collective first and competitive inside:

```json
{ "id": "g-7mfa…", "exerciseId": "x-k3p9…", "fromDay": "2026-10-01", "toDay": "2026-10-31",
  "target": 1000, "createdBy": "<userId>", "createdAt": 1791489600000, "memberCount": 12 }
```

- **Membership, not friendship, decides what you see.** Members see each other's names and
  each member's day totals for the challenge's exercise, for days in the window. Not other
  exercises, not other days, not profiles. Without this, two people who each joined
  through your link couldn't see each other, and the board would break for exactly the
  people it was for.
- **Joining befriends only the person whose link you opened.** Any member can send any
  other a friend request (see Friend requests).
- **The server projects.** A non-friend member's day totals leave the server cut down to
  that one exercise and window, never whole.
- **`target` is optional**, in the exercise's unit. Without one, the group total still
  shows.
- **The window** is at most 62 days, so a challenge board is one leaderboard-sized read. Each
  member's days are their own local days, as on every board.
- **Leaving** deletes your membership. Your sets stay yours. The challenge item outlives
  its window, so profiles can show past challenges ("Red Rocks October: 12 people,
  1,043 laps").
- Creating a challenge needs an exercise you can see. It is adopted by everyone who joins,
  so the whole group logs to the same id.

### Friend requests

A friend sees your profile and every day total, so becoming friends takes both people. A
link carries consent by being shared. Everywhere else, it's a request.

- **Who can request whom:** two people who are members of the same challenge, now or in
  the past. The request names that challenge, and the server checks both memberships with
  two point gets. Eligibility is a rule in one place, so another source (friends of
  friends, say) is an added check, not a new mechanism.
- **Accepting** deletes both sides of the request and writes both sides of the friendship
  in one transaction. **A request to someone who already requested you** accepts theirs.
- **Declining is silent and final.** The receiver's side becomes a tombstone with
  `declinedAt`. The sender still sees "Requested", and sending again is a no-op. A cancel
  by the sender deletes both sides, unless it's already a tombstone.
- **At most 50 requests a day** per sender, counted like compose usage.
- Incoming requests arrive in the sync response, so every client can badge Friends
  without a separate poll. Push is later.

### Boards

A board is a spec the client evaluates over friends' day totals:

```json
{ "metric": "count", "exerciseId": "x-k3p9…", "period": "month" }
```

`metric` is one of `count`, `sets`, `bestSet`, `activeDays`, `goalPercent`. `period` is
`today`, `week`, `month`, or a fixed `fromDay`/`toDay` window for a challenge. Weeks and
months are calendar periods in each person's own zone, so everyone gets a fresh start on
Monday. Specs are a shared TS and Swift type, pinned by fixtures (`boards.json`).

A challenge board evaluates the same specs over its members instead of your friends, and
leads with the group: the members' summed count toward the target (or just the sum, with no
target), then the ranking inside it, by `count` unless the viewer picks another metric.

The rules `evaluateBoard` (`src/shared/boards.ts`) and `boards.json` pin:

- **Higher is better.** A tie on the value breaks by `count` over the same days (except
  when ranking by `count` itself). Members still tied **share a rank** (1, 1, 3) and are
  listed by name, then id.
- **`count`** across exercises is the ring (`reps`); for one exercise it is that exercise's
  `reps` or `holdSeconds`, in its own unit. **`bestSet`** likewise.
- **`goalPercent`** is 100 × the ring reps in the period ÷ (goal × days elapsed in the
  period, up to the member's today), so a week is fair on Wednesday. It always reads the
  ring, whatever the exercise. A member with no goal has no value: listed last, unranked.
- A pre-v2 day total reads as all pull-ups (`exerciseDayTotals`).
- The PWA's default board is this week, days active, ties broken by count (product.md,
  open question 7). The client asks the server for two days either side of its own period,
  so a friend whose today is a date ahead or behind is covered.

The server stores totals and never ranks, so a new metric, a different default, or a tweak
to how ties break ships in a client release. The limit: a metric can only use what a day
total holds. A new day-total field (say, longest hold within a set) is additive, since
totals recompute on every change, but past days only get it through a backfill. Add the
candidates in M0, while the data is one user's.

### New items

| pk | sk | item |
|---|---|---|
| `U#<userId>` | `K#<credentialId>` | passkey: public key (COSE), sign count, transports, createdAt, label |
| `U#<userId>` | `T#<digest>` | a session token from the account's side (createdAt), written with every `T#<digest> T` since passkeys, so the sweep and revocation can find an account's tokens without a scan |
| `U#<userId>` | `F#<friendId>` | friendship (written on both sides in one transaction): createdAt |
| `U#<userId>` | `L` | the user's current friend link: `code` (readable, see Links) and `codeHash`, so rotating it can delete the old `I#` item. Challenge links aren't tracked here. They expire. |
| `U#<userId>` | `Q#<day>` | compose usage counter for the day, with `ttlEpochSeconds` |
| `U#<userId>` | `R#<fromUserId>` | incoming friend request: createdAt, challengeId, declinedAt? |
| `U#<userId>` | `S#<toUserId>` | the same request from the sender's side, written in the same transaction |
| `U#<userId>` | `RQ#<day>` | friend requests sent that day, with `ttlEpochSeconds` |
| `U#<userId>` | `A#<key>` | adopted definition: `adoptedAt`. `key` is `<exerciseId>` for an exercise or `<exerciseId>/<variationId>` for a variation (the variation's id alone doesn't say where it's stored). |
| `X#<exerciseId>` | `X` | created exercise |
| `X#<exerciseId>` | `V#<variationId>` | created variation on that exercise (built-in exercises too: `X#pull-up V#v-…`) |
| `C#<digest>` | `C` | pending WebAuthn challenge: purpose, userId?, name?, timeZone?, expiresAt, ttlEpochSeconds |
| `W#<day>` | `U#<userId>` | the empty-account sweep looks at this account on `<day>` (UTC), 30 days after sign-up |
| `I#<digest>` | `I` | gains the link kinds `friend` and `challenge`, with `createdBy`, the payload, `openCount`, `joinCount` and `ttlEpochSeconds` for challenges (see Links). `device` invites are unchanged. |
| `G#<challengeId>` | `G` | challenge (see Challenges) |
| `G#<challengeId>` | `M#<userId>` | membership: joinedAt, the member's challenge-link digest |
| `U#<userId>` | `G#<challengeId>` | the same membership from the user's side, written in the same transaction, with `toDay` so active challenges list without a get per challenge |

None needs a new index. Passkey login finds the credential through the `userHandle` the
authenticator returns, which is the user id. Friends are a query on `U#<userId>` with
`begins_with(sk, "F#")`. A friend's day totals are a query on `U#<friendId>` between
`D#<from>` and `D#<to>`. A challenge's members are a query on `G#<challengeId>` with
`begins_with(sk, "M#")`, and yours are the same on `U#<userId>` with `G#`. Exercise
definitions are point gets.
`test/dynamodb.test.ts`'s `CreateTableCommand` doesn't change.

## API

Every change is additive except the protocol gate.

**Protocol gate.** `/api/sync` requires `protocolVersion: 2` in the body. Without it the
server returns 426 *Update the app* with `{ protocolVersion }`, the version it speaks. The
gate runs before authentication, so a stale client writes nothing. A v2 client that meets a
426 (from a future v3 server) stops syncing until it reloads, and offers *Update now*. A v1 client's `normalizeEntry` strips fields it
doesn't know, so if it edited a chin-up, its edit would win under last-writer-wins and turn
the chin-up back into a pull-up. With the gate, a stale PWA sees 426 once, and the service
worker loads the new code on its next launch.

**`POST /api/sync`**
- Request: `{ protocolVersion, pushedEntries, pushedDefinitions, sinceCursor }`.
  `pushedDefinitions` holds created exercises and variations, each merged last-writer-wins
  and rejected if a non-creator tries to change one.
- Response: as today, plus `definitions`: every definition on your adopted list, plus any
  created id the returned entries reference. Exercises and variations share the array; the
  `x-`/`v-` prefix says which is which. `account` gains the new profile fields and
  `incomingRequests: [{ id, name, challengeId }]`, without tombstones.

**`POST /api/profile`**: `{ name?, nameUpdatedAt?, dailyGoalReps?, goalUpdatedAt?, timeZone?, zoneUpdatedAt? }`,
last-writer-wins per field; every value comes with its clock (`validation.json`'s
`profilePatches`). Returns the stored profile, shaped like the sync response's `account`.
A zone change rebuilds recent day totals before it returns (see Time zones).

**`POST /api/friends`**: `{}` → `{ friends: [{ id, name }], friendLink }`. `friendLink` is
the code; the friend link is made the first time it's asked for, so accounts from before
links get one too.
**`POST /api/friends/remove`**: `{ friendId }` deletes both sides. It answers `{}` whether
or not the two were friends, so it can't probe for accounts.
**`POST /api/friends/rotate-link`**: invalidates your old link, returns a new one.
**`POST /api/friends/request`**: `{ userId, challengeId }` → `{ status: "requested" | "friends" }`.
Idempotent. An ineligible target gets 404, so the endpoint can't probe for accounts.
**`POST /api/friends/respond`**: `{ userId, accept }`.
**`POST /api/friends/cancel`**: `{ userId }`.
**`POST /api/friends/suggestions`**: `{}` → members of your challenges who aren't your
friends, with the challenge you share and any request state.

**`POST /api/links/resolve`** (unauthenticated): `{ code }` → `{ kind, inviterName,
challenge?: { definition, fromDay, toDay, target, memberCount, groupTotal } }`, enough for
the landing page to lead with the exercise. Aggregates only, no member names. Bumps
`openCount`. Rate-limited with the sign-up endpoints.
**`POST /api/links/redeem`**: `{ code }` → `{ kind, friend: { id, name }, challenge?, definition? }`.
Makes the friendship, and for a challenge link the membership and the adopted exercise, in
one transaction. Bumps `joinCount` when it made something new. Idempotent. Redeeming your
own link is 400. An unknown, expired or rotated code, a device link and a pre-passkey
invite all answer 404. Replaces `/api/friends/add`.

**`POST /api/challenges/create`**: `{ exerciseId, fromDay, toDay, target? }` →
`{ challenge, link }`. The creator is the first member.
**`POST /api/challenges/list`**: `{}` → your challenges, active and past, with their
definitions.
**`POST /api/challenges/link`**: `{ challengeId }` → your own link for it. Members only.
**`POST /api/challenges/leave`**: `{ challengeId }`.
**`POST /api/challenges/board`**: `{ challengeId }` → `{ challenge, definition, members:
[{ id, name, isFriend, days }] }`, each member's days projected to the challenge's
exercise and window. A non-member gets 404. A cap of 200 members keeps it one bounded
fan-out, like the leaderboard.

**`POST /api/leaderboard`**: `{ fromDay, toDay }`, at most 62 days.
- Response: `{ users: [{ id, name, timeZone, dailyGoalReps?, days: [DayTotal] }], definitions }`,
  for you and your friends. `definitions` are the created exercises those days name, so
  friends' invented exercises have names. Day totals leave without their `version`.
- Implementation: one friends query, then one day-total query per friend, in parallel, plus
  a batch get of profiles and definitions. A cap of 200 friends keeps this bounded. The
  `by-month` GSI is no longer needed for the board. It stays for operators' cross-user
  reports.
- The client ranks, by evaluating a board spec over the response. Metrics, periods and the
  default are client decisions, and a widget can compute "you're #2 today" from the same
  response.

**`POST /api/profile/view`**: `{ userId }`, friends (and yourself) only → `{ profile: { id,
name, timeZone, dailyGoalReps? }, days (last 90, in their zone), exercises: [{ exerciseId,
totals: { sets, activeDays, reps?, holdSeconds? }, bests: { bestSetReps?, bestHoldSeconds?,
bestAddedWeightLbs? } }], definitions }`. Totals and bests are lifetime, from every stored
day total. A built-in exercise has no definition on the wire, so exercises carry
`exerciseId` and created ones come in `definitions`. A non-friend, a missing account and a
malformed id all get the same 404, not 403, so ids don't reveal accounts.

**`POST /api/compose`** (see The composer): `{ text, nowMs, timeZone, knownExercises: [{ id, name, measure, unit }] }`
→ `{ draft }`. Authenticated, capped per user per day.

**Sign-up and passkeys** (see Auth):
- `POST /api/signup/options` `{ name, timeZone?, dailyGoalReps?, linkCode? }` → creation
  options for a fresh user id. 403 while sign-up is closed. `dailyGoalReps` is the goal the
  device was using, kept on the profile without a clock (so any edit beats it), so a new
  account ranks on "% of goal" from day one.
- `POST /api/signup` `{ credential, label }` → `{ token, account, redeemed? }`. `redeemed`
  is what the link did, shaped like `/api/links/redeem`'s response. A link that is dead at
  `/api/signup/options` is 404; one that dies before `/api/signup` makes a plain account.
- `POST /api/passkey/register/options` and `/api/passkey/register` (authenticated): add
  another passkey. Register returns `{ passkeys }`.
- `POST /api/passkey/list` (authenticated) → `{ passkeys: [{ credentialId, label?, createdAt }] }`.
- `POST /api/passkey/login/options` → request options, with no `allowCredentials`.
- `POST /api/passkey/login` `{ credential, label }` → `{ token, account }`.
- Without a custom domain, every passkey endpoint answers 503.

**`POST /api/join` is retired for new accounts.** It redeems device links only
(`/api/invite {kind:"device"}`), which stay for the Watch and for recovery; a friend invite
from before passkeys is refused with 410.

**`POST /api/account/delete`** deletes the whole `U#<userId>` partition, both sides of
every friendship and friend request, and every challenge membership. Created exercises stay, with `createdBy` cleared, because friends' sets
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
1. Enter a display name (1–24 characters, not unique, editable later). 24, not more, because
   names sit in narrow board rows, and it is the limit names already had.
2. `/api/signup/options` makes a user id and a challenge that remembers the name, the
   device's zone and the link code, if any.
3. The device creates a passkey. `/api/signup` verifies it, then writes the profile (with
   `joinedVia`), the passkey and the session token in one transaction. If a link came with
   it, the same transaction redeems it: the friendship, the adopted exercise, `joinCount`.

No account exists without a passkey, so there's no half-made state to nag about.

**Sign-up is closed** unless the deployment sets `signup_open` (the `SIGNUP_OPEN` repository
variable). Signing in, adding a passkey to an existing account and redeeming a device link
work either way. That is what keeps the domain rule below: until the final domain is in
place, only the operator, whose account predates passkeys, registers one.

**Signing in anywhere.** Tap **Sign in**, then Face ID. The system offers the discoverable
passkey for the domain, and `/api/passkey/login` mints a session token for this device.
There's no username field.

**Sessions.** The existing `T#<digest>` device tokens are reused as session tokens. Each
new one also gets a `U#<userId> T#<digest>` item, so an account's tokens can be found.
Revocation (`invite.sh revoke`) also deletes the user's `K#` items.

**Signing in as another account** on a device drops the synced sets and definitions of the
account it was signed into, keeping only work not yet synced, so one account's history never
shows in (or gets edited into) another.

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
- **`boards.json`**: board specs, friends' or members' day totals and the expected ranking
  and group total, including ties, missing days, goal-less users and members in other
  zones.
- **`compose/`**: drafts and the known-exercise lists they resolve against.

The TS suites already contain most of the merge and day cases inline. M0 lifts them into
fixtures.

## Risks

| Risk | Mitigation |
|---|---|
| Passkeys bound to the wrong domain | Only the operator registers on the interim domain. Move to the final domain before links go out (the M2 checkpoint). |
| A stale client strips v2 fields | The protocol gate (see API). |
| A board metric needs data day totals don't hold | Add candidate fields in M0, while there is one user. Later fields need a backfill. |
| Requests used to probe or spam | Only between members of a shared challenge, 404 for anyone else, 50 a day, silent final declines. |
| Challenges show people to non-friends | Only names and one exercise's totals within the window, only to members of the same challenge, projected on the server. Leaving is the block. Report arrives in M5 with the rest. |

## Alternatives considered

- **The model choosing exercise ids.** Fewer moving parts, but ids are opaque strings a
  small model gets wrong, and the on-device model's context can't hold every id.
- **The on-device model first on iOS.** Free, private and offline, but it means two
  models, two eval loops, a fallback and availability branching before anyone has used
  Describe. Haiku at the daily cap costs little. Kept as a later optimization.
- **Link parameters in the URL** (`#friend=<code>&x=<exerciseId>`). Simpler, but the URL
  format becomes a contract with every link already shared, and there's nowhere to count
  opens. A stored payload can change meaning and be retired.
- **Challenge members as each other's friends.** Simplest visibility rule, but joining one
  challenge would fill your friend list with strangers and show them everything.
- **Hub-and-spoke challenges** (members see only the people they're friends with).
  No new visibility rule, but two people who joined through the same link can't see each
  other, so the group total and the ranking are wrong for everyone but the creator.
- **Adding a challenge member without a request.** One fewer step, but it would show them
  your whole profile and every day total without asking.
- **Server-ranked leaderboards.** Smaller responses, but every ranking change becomes an
  API change. Friend counts are small, so the client ranks.
- **CloudKit instead of AWS.** Cross-user queries are awkward in CloudKit, it has no
  Android story, and it would discard a working backend.
