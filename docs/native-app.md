# Pull-up Tracker v2: design

Status: **draft**, revised 2026-10-12 to take in the product direction set that night.
This doc covers the decisions that are expensive to reverse: data formats, the API, auth,
the social graph, and how the iOS code is laid out and tested. Screens and interactions are
deliberately left loose. They are cheaper to find by using a build than by specifying them
here.

## Summary

The app grows from a pull-up log into a log for **any movement anyone can describe**, and
gains a native iOS app. The app does two things, both as simply as possible: it gets data
in, and it shows stats.

- **One input pattern for everything:** reps, then exercise, then configuration, then Log.
  The exercise and configuration are prefilled from your history, so the common case is a
  number and Log. Repeating a set or a whole session is one tap.
- **Describe anything.** Type or say what you did ("3 laps of the Red Rocks stairs, 20
  push-ups at the top each time"). A language model composes it into sets for you to
  confirm. On iOS the model runs on the device. On Android and the web, the server calls
  Claude Haiku.
- **Exercises are open.** Anyone can define an exercise or a variation, and the backend
  stores it at face value. Your exercises show up on your friends' leaderboards and on your
  profile. This is the hook.
- **Sign-up is a name and a passkey.** No email, no phone, no invite. Free forever, with
  no monetization.
- **Friends are a graph.** You add friends with a link or QR code. Leaderboards and profiles
  cover you and your friends.

The AWS backend stays and gets additive changes. The iOS client is SwiftUI over a plain
Swift package (`PullupCore`) that builds and tests on Linux. Android users get the PWA,
which keeps developing as a full client instead of freezing.

## Goals

1. **Getting data in is as fast as possible.** A single set and a ten-set mixed session
   are equally easy. Repeating the last set or a past session is one tap.
2. **Any movement fits one input pattern**: reps, holds, stairs, laps, made-up drills. If
   the pad can't express it, a sentence can.
3. **Stats read at a glance.** One ring for today's reps, plus per-exercise history.
4. **Signing up takes a name and Face ID**, and the login survives a new phone, a deleted
   app or wiped storage.
5. **Friends see each other**: leaderboards, profiles, and each other's invented exercises.
6. **Free to run.** No revenue, so running costs stay at pennies per active user, with hard
   caps on the one paid dependency (Haiku).
7. **The existing guarantees hold:** no lost writes, local-first logging, offline works.

## Non-goals

- Monetization of any kind: ads, subscriptions, tips, data sales.
- Real identity: email, phone number, contacts upload, legal names.
- Feeds, comments and reactions. The leaderboard and profiles are the whole social surface.
- Workout programs, coaching, difficulty weighting.
- Moderating exercise names beyond length and character checks. Visibility is limited to
  friends, and unfriending is the block (see Risks).
- A native Android app, for now. Android uses the PWA.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Input order | Reps → exercise → configuration → Log, with exercise and configuration prefilled. |
| Repeat | "Repeat last set" logs immediately. "Repeat session" turns a past session into a queue that each Log advances. |
| Exercises | Built-ins ship in `catalog.json`. Anyone can create more. The server stores them at face value. |
| Measures | An exercise is counted (in a unit it names: rep, step, lap, flight…) or timed (seconds). |
| Ring | Sums counted sets whose unit is **rep**. Other units and holds show per exercise, not on the ring. |
| Natural language | Composes a **draft** of sets that you confirm. It never logs directly. |
| Composer model | iOS: Apple's on-device Foundation Models. Android/web, and iOS devices without Apple Intelligence: `/api/compose` → Claude Haiku 5.5. |
| Sign-up | Open. A display name, then a passkey. No account exists without a passkey. |
| Friends | Mutual, made by a personal friend link or QR code. |
| Visibility | Friends see your profile, day totals and exercise definitions. Never individual sets. |
| Time zone | **Per user**, stored on the profile. Replaces Denver-for-everyone. |
| Old data | A set with no `exerciseId` is a pull-up. Existing users get `America/Denver` as their zone. No migration. |
| Old clients | `/api/sync` requires `protocolVersion: 2`. Older clients get 426 until they update. |
| Android | The PWA, kept current. Passkeys work through Google Password Manager. |
| iOS distribution | TestFlight while building. The App Store once friends and profiles land (open sign-up makes it viable). |
| iOS minimum | iOS 26 / watchOS 26. |
| iOS logic | `PullupCore` Swift package, dependency-light, tested on Linux. |
| Local storage | SQLite (via GRDB) in the App Group container, shared by app, widgets and intents. |
| Project file | Generated by XcodeGen from `project.yml`. `.xcodeproj` is not committed. |
| CI | Linux: TS + `PullupCore`. macOS runner: Xcode build and tests. Xcode Cloud: TestFlight. |

## 1. Product shape

Directional, not a spec.

### Logging

The Today screen reads top to bottom in the order you log:

```
            ( ring: 61 reps today )

  [ 5 ] [ 6 ] [ 7 ] [ 8 ] [ 9 ] [ 10 ]      1. reps: six counts around your usual
  Pull-up ▾                                 2. exercise: last one used
  [wide ✓] [into tuck] [negative] [ + ]     3. configuration: your recent ones
  [        Log 8 · Pull-up · wide        ]  4. Log

  Repeat:  [ 8 · Pull-up · wide ]  [ Tuesday · 9 sets ]
  ✎ Describe what you did…
```

- **Reps first.** The pad adapts to the selected exercise and configuration: it shows six
  counts around your usual for that combination. A timed exercise turns the pad into a
  start/stop timer plus quick durations. A counted exercise in another unit labels its
  numbers ("laps", "flights").
- **Exercise and configuration are sticky.** They prefill from your last set, so most sets
  are a number and **Log**. Changing exercise is one tap on a recent-exercise chip, or the
  picker for anything else. The configuration chips are the variations you've used with
  that exercise ("wide grip", "into tuck", "negative"), and **+** adds a new one by name.
- **Log** commits the set and leaves the context in place, so the next set of the same
  thing is a number and Log again.
- **Repeat last set** logs an exact copy in one tap. It is also what the widget, the
  Control Center control, the Action button and the Watch do.
- **Repeat session.** A session is just sets close together (a gap of under 90 minutes),
  so there's no "start workout" mode to forget. Tapping a past session loads it as a
  **queue**: the card shows the next set, and each Log advances it. Skip and edit work on
  queue items. A single set and a session therefore use the same buttons. A session is a
  queue you walk through.
- **Undo, haptics and the double-tap guard** carry over from the PWA.
- **Added weight** stays sticky per exercise for the day and resets to bodyweight the next
  day, as today.

### Describe it

The text field (with dictation) takes anything:

> "Ran the Red Rocks stairs 3 times, 20 push-ups at the top each time, then a 45 second
> front lever tuck"

The composer returns a **draft**: one card per set, in order, each editable, with **Log
all** at the bottom. Exercises it recognises (yours, your friends', the built-ins) are
matched to their ids. One it doesn't recognise appears as **New exercise: Red Rocks
stairs, counted in laps**, with the name, unit and a description in your words. Logging
creates it.

The draft is the safety net. A model that misreads "3x10" as one set of 310 costs an edit,
not a corrupted history. Relative times work too ("yesterday evening"), and become each
set's `doneAt`.

The same composer makes a new exercise from the picker: "+ New exercise", describe it, and
it suggests the name and the measure. Or you fill in the three fields yourself.

### Stats

Per exercise or across all of them: today, streaks, completed-day averages, week-to-date,
best day, best set, heaviest set. Each exercise reads in its own unit ("312 laps this
year"). Charts use Swift Charts on iOS and the existing SVG charts in the PWA.

### Friends, leaderboards, profiles

- **Your friend link** (`https://<domain>/#friend=<code>`, also a QR code) is the one way
  in. Someone opening it who isn't signed up picks a name, creates a passkey, and is your
  friend when it finishes. That's the growth loop: you invite someone because you want them
  on your board.
- **Leaderboard:** you and your friends, for today, this week and this month. Rankings:
  total reps (the ring), % of your own goal, and **any single exercise**, including made-up
  ones. "Red Rocks stairs, this month" is a board as soon as two friends have logged it.
- **Profiles:** a friend's ring, streak, their exercises with totals and bests, and their
  recent days. Tapping one of their exercises offers **Add to mine**, which puts it in your
  picker under the same id, so you both land on the same board. This is how invented
  exercises spread.

## 2. Data model v2

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
same chain is implemented in Swift and checked against shared fixtures (§6).

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

### New items

| pk | sk | item |
|---|---|---|
| `U#<userId>` | `K#<credentialId>` | passkey: public key (COSE), sign count, transports, createdAt, label |
| `U#<userId>` | `F#<friendId>` | friendship (written on both sides in one transaction): createdAt |
| `U#<userId>` | `L` | the user's current friend-link digest, so rotating it can delete the old `I#` item |
| `U#<userId>` | `Q#<day>` | compose usage counter for the day, with `ttlEpochSeconds` |
| `X#<exerciseId>` | `X` | created exercise |
| `X#<exerciseId>` | `V#<variationId>` | created variation on that exercise (built-in exercises too: `X#pull-up V#v-…`) |
| `C#<digest>` | `C` | pending WebAuthn challenge: purpose, userId?, name?, expiresAt, ttlEpochSeconds |
| `I#<digest>` | `I` | gains `kind: "friend-link"`, reusable, no expiry. `device` invites are unchanged. |

None needs a new index. Passkey login finds the credential through the `userHandle` the
authenticator returns, which is the user id. Friends are a query on `U#<userId>` with
`begins_with(sk, "F#")`. A friend's day totals are a query on `U#<friendId>` between
`D#<from>` and `D#<to>`. Exercise definitions are point gets.
`test/dynamodb.test.ts`'s `CreateTableCommand` doesn't change.

## 3. API

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
**`POST /api/friends/add`**: `{ code }` → `{ friend: { id, name } }`. Idempotent.
**`POST /api/friends/remove`**: `{ friendId }` deletes both sides.
**`POST /api/friends/rotate-link`**: invalidates your old link, returns a new one.

**`POST /api/leaderboard`**: `{ fromDay, toDay }`, at most 62 days.
- Response: `{ users: [{ id, name, timeZone, dailyGoalReps, days: [DayTotal] }], definitions }`,
  for you and your friends.
- Implementation: one friends query, then one day-total query per friend, in parallel, plus
  a batch get of profiles and definitions. A cap of 200 friends keeps this bounded. The
  `by-month` GSI is no longer needed for the board. It stays for operators' cross-user
  reports.
- The client ranks. Periods, the exercise filter and "% of goal" are client decisions, and a
  widget can compute "you're #2 today" from the same response.

**`POST /api/profile/view`**: `{ userId }`, friends only → `{ profile, days (last 90),
exercises: [{ definition, totals, bests }] }`. A non-friend gets 404, not 403, so ids don't
reveal accounts.

**`POST /api/compose`** (§5): `{ text, nowMs, timeZone, knownExercises: [{ id, name, measure, unit }] }`
→ `{ draft }`. Authenticated, capped per user per day.

**Sign-up and passkeys** (§4):
- `POST /api/signup/options` `{ name, friendCode? }` → creation options for a fresh user id.
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

## 4. Auth: a name and a passkey

**Why passkeys.** A passkey belongs to the domain and syncs through iCloud Keychain or
Google Password Manager. A new phone, a reinstalled app or wiped storage all sign back in
with Face ID or a fingerprint. No email or password exists to collect, leak or reset. That
matches "no real identity": the account is a display name and a key.

**Sign-up.**
1. Enter a display name (1–40 characters, not unique, editable later).
2. `/api/signup/options` makes a user id and a challenge that remembers the name and the
   friend code, if any.
3. The device creates a passkey. `/api/signup` verifies it, then writes the profile, the
   passkey and the session token in one transaction, and the friendship if a code came
   with it.

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
- A CloudFront/WAF rate rule on `/api/signup*` per IP.
- An account with no entries and no friends after 30 days is deleted by a scheduled sweep.

**Challenges** are 32 random bytes, stored as `C#<sha256>` with a 5-minute expiry, consumed
with a conditional delete so one can't be replayed. **Verification** uses
`@simplewebauthn/server`, attestation `none`.

**The domain is the anchor.** Every passkey is bound to the relying-party id, the app's
custom domain. **Choose the final domain before anyone registers a passkey.** Changing it
later strands every credential. The custom domain (already supported in `infra/`) becomes a
requirement.

**Associated Domains (iOS).** The site serves `/.well-known/apple-app-site-association`
(`application/json`, no redirect) with `webcredentials` and `applinks` entries. The app
declares `webcredentials:<domain>` and `applinks:<domain>`. Friend links keep the code in
the fragment (`#friend=<code>`) so it never reaches CloudFront logs. AASA `components` can
match a fragment. Verify on a device early. The fallback is a "Paste link" field.

**Android.** The PWA in Chrome uses passkeys on the same domain with no extra setup. A
native Android app would need a Digital Asset Links file. Not needed yet.

**Not Sign in with Apple.** It would add an identity to link to. Passkeys are not
third-party login, so the App Store rule requiring Sign in with Apple doesn't apply.

## 5. The composer

The composer turns text into a draft session. It never writes data. The client shows the
draft and logs what you confirm.

### One output shape, two models

Both paths produce the same JSON, so the draft UI and everything after it are shared:

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

### iOS: on-device

Apple's Foundation Models framework (iOS 26) runs a small model on the device, with
**guided generation**: a `@Generable` Swift struct constrains the output to the shape
above. It is free, private and works offline, which is why iOS uses it.

- It needs Apple Intelligence: an iPhone 15 Pro or later, with the feature on and a
  supported language. Its context window is small (about 4,000 tokens), so the prompt
  carries only your 40 most-used exercise names, not the whole catalog.
- When the model is unavailable, the app falls back to `/api/compose`. The first time it
  does, it asks for consent, because that sends the text to a third-party AI service.
  App Review requires that disclosure.

### Android and web: Haiku

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
- **Privacy:** the text goes to Anthropic's API. No name or user id is sent with it.

### Evaluation

`test/fixtures/compose/` holds descriptions and their expected drafts: plain ("4x8 wide
pull-ups"), mixed sessions, holds, relative times, unknown exercises, and junk input that
should return an empty draft. The resolver is tested on them in both languages. The Haiku
prompt is checked against them by a script run manually, not in CI, because every run
costs money. The on-device model is checked the same way from a device build.

## 6. iOS architecture

### Layout

```
ios/
  project.yml                 XcodeGen spec: targets, entitlements, App Group, signing team
  PullupCore/                 Swift package — no UIKit/SwiftUI; builds and tests on Linux
    Sources/PullupCore/       Entry, merge, catalog, definitions, DayCalendar, Stats, Resolver, SyncEngine, APIClient
    Tests/PullupCoreTests/    runs shared fixtures + engine tests with a fake transport
  App/                        SwiftUI app: screens, composer (Foundation Models), App Intents, Live Activity, passkey UI
  Widgets/                    WidgetKit: ring, interactive repeat-set, Control Center control
  Watch/                      watchOS app + complications
  Shared/                     GRDB store and App Group plumbing used by App, Widgets, Watch
```

It lives in this repo. An API change and both clients land in one PR, and the fixtures are
shared. The `.xcodeproj` is generated by XcodeGen and git-ignored. A project file is
hostile to merges and can't be checked without Xcode. `project.yml` is readable text any
session can edit.

The Foundation Models call lives in `App/`, because the framework doesn't exist on Linux.
Everything around it (the prompt, the shortlist, the resolver, draft expansion) is in
`PullupCore` and tested there.

### Two implementations, one behavior

Merge rules, day keys, stats and name resolution exist in TypeScript (server and PWA) and
in Swift. Behavior is pinned by **shared JSON fixtures** in `test/fixtures/`, and both test
suites run every case:

- **`merge.json`**: pairs of versions and the expected winner, including every tiebreak
  step and v1 → v2 shapes.
- **`days.json`**: instants, zones and their day key: Denver, London, Sydney and Kolkata,
  both DST transitions, midnight crossovers, month and year edges. Wall-clock → instant
  cases too.
- **`validation.json`**: valid and invalid entries and definitions.
- **`stats.json`**: an entry history, a zone, a "now", and the expected stats.
- **`compose/`**: drafts and the known-exercise lists they resolve against.

The TS suites already contain most of the merge and day cases inline. M0 lifts them into
fixtures.

`catalog.json` reaches the Swift package as a copied resource. A CI step fails if the copy
differs from `src/shared/catalog.json`.

### PullupCore

- **`Entry`, `Definition`, `pickWinner`, `normalize`, `isValid`**: ports of `model.ts`.
- **`DayCalendar(zone:)`**: a Gregorian `Calendar` in the user's zone. Day keys stay
  `YYYY-MM-DD` strings with pure calendar arithmetic, as in `time.ts`.
- **`Stats`**: a port of `stats.ts`, extended per exercise and per unit.
- **`Resolver`**: names to ids, and draft expansion.
- **`SyncEngine`** is an actor that ports `tracker.ts`'s semantics: 1.2 s debounce,
  exponential backoff capped at 5 minutes, at most one sync in flight with a queued rerun,
  an outbox entry cleared only if the acknowledged version is still the latest, and the
  cursor reset when the account changes. It depends on `ReplicaStore` (entries,
  definitions, outbox, cursor, account, settings, each mutation transactional) and
  `Transport`. Tests use in-memory implementations, as `test/tracker.test.ts` does.
- **`APIClient`** builds requests, including the `x-amz-content-sha256` payload hash
  CloudFront's origin access control needs, using `swift-crypto`. That is the package's
  only dependency.

### Storage across processes

The app, widget extension and App Intents can each write a set, in separate processes. All
use one SQLite database in the App Group container, through GRDB, in WAL mode. Each write
is one transaction: upsert the entry and add it to the outbox.

Any process may run a sync. Two concurrent syncs are safe by construction: pushes are
idempotent merges, the cursor is written as `max(stored, new)`, and outbox rows are cleared
only where the stored `updatedAt` still matches the one sent.

At about 4,000 sets a year, the whole history loads into memory for stats in milliseconds.
SQLite is there for safe concurrent writes, not for size. SwiftData was rejected: its
multi-process behavior is opaque, it can't be tested on Linux, and it would sit awkwardly
between the CRDT and its own change tracking.

### Sync triggers on iOS

- **A write.** Debounced, inside `beginBackgroundTask`, so a set logged just before the
  phone locks still goes out.
- **Foreground**, and every minute while the app is visible.
- **Widget and intent writes** try a short sync (about 3 s), then leave the rest to the app.
- **`BGAppRefreshTask`** pulls friends' totals opportunistically, to keep widgets fresh.
- **Every write** reloads widget timelines and updates the Live Activity.

### Watch

The Watch is a full sync client with its own session token. The phone requests a device
link and sends the code over WatchConnectivity, and the Watch redeems it. It syncs straight
to the server over Wi-Fi or LTE, with or without the phone. The Watch gets the pad and
Repeat, not the composer.

## 7. The PWA

The PWA is the Android and web client, so it no longer freezes. It keeps the same input
pattern and the same features as iOS, minus what needs the platform: widgets, Live
Activities, the Watch and the on-device model. Its composer is always `/api/compose`.

Keeping two clients current is the cost of Android without a native app. The shared TS
code (`model`, `time`, `stats`, the resolver) is most of the logic, so the PWA's extra work
is mostly UI.

## 8. Apple platform surfaces

| Surface | What it does | Milestone |
|---|---|---|
| Foundation Models | The on-device composer. | M4 |
| App Intents + App Shortcuts | "Log 8 pull-ups", "Repeat last set", "Log: three laps of Red Rocks", "How many today?" from Siri, Spotlight and Shortcuts. | M4 |
| Swift Charts | Trends and per-exercise history. | M4 |
| Passkeys (AuthenticationServices) | Sign-up and sign-in. | M3 |
| Haptics, SF Symbols, the system design | Native feel. | M3 |
| Interactive widgets | Home and Lock Screen ring. "+ repeat last set" without opening the app. StandBy. | M6 |
| Control Center control | "Repeat last set", also on the Action button and Lock Screen. | M6 |
| Live Activity | During a session: today's total, the queue's next set and a rest timer. A running hold timer. | M6 |
| watchOS app | Pad and Repeat. Double Tap repeats. Complication for the ring. | M7 |
| Push (APNs) | "Sam just passed you." "Alex added Red Rocks stairs." | later |
| HealthKit | Optionally write sessions as workouts. | later |

## 9. Build, test, release

**Cloud sessions run Linux and can't run Xcode.** That shapes the loop:

| Layer | Where it builds and tests | Who verifies |
|---|---|---|
| Server, TS shared code, PWA, fixtures | Linux: `npm run check` | CI and cloud sessions |
| `PullupCore` | Linux: `swift test` (Swift toolchain in the environment setup script) | CI and cloud sessions |
| App, widgets, Watch (compile + unit tests) | macOS runner: `xcodegen generate && xcodebuild test` | CI, logs readable from a session through GitHub |
| Look, feel, haptics, the passkey ceremony, the on-device model | A device | **You**, from TestFlight, with a short checklist per milestone |

**CI.** `pipeline.yml` gains a Linux `swift test` step. A separate macOS job builds and
tests the Xcode project, only when `ios/**` or the fixtures change (macOS minutes cost
about 10× Linux). PR checks use GitHub Actions, not Xcode Cloud, so a session can read the
logs and fix its own red build.

**Release.**
- Xcode Cloud builds and uploads to TestFlight on pushes to `main` that touch `ios/`.
  Signing stays with Apple.
- **TestFlight** while building (M3–M4): a public link, light beta review.
- **The App Store** from M5. Open sign-up and a share-a-link growth loop only work if a
  friend can install from the App Store. TestFlight builds expire after 90 days and cap at
  10,000 testers. App Review will want: account deletion, a privacy label (name, fitness
  data, nothing linked to identity), the third-party-AI consent for the fallback, and a
  way to report or block other users' content (see Risks).

**You'll need to provide:** the Apple Developer Program membership ($99 a year), a bundle
id and App Group, the final domain, an Anthropic API key for `/api/compose`, and Swift in
this environment's setup script.

## 10. Milestones

Each milestone ends in something you can use. M0–M2 are server and PWA work that cloud
sessions can do start to finish. They also make Android and web fully usable before any
Swift exists.

**M0: model v2.**
- Shared fixtures, `catalog.json`, per-user time zones (existing users on Denver).
- The v2 entry, created exercises and variations, definitions in sync.
- Day totals with `byExercise` and the rep-unit ring rule.
- The protocol gate, with the PWA sending v2.
- The profile fields and `/api/profile`.

*Done when:* `npm run check` and the DynamoDB suite are green and deployed, and old data
reads the same.

**M1: open sign-up and friends.**
- Passkey sign-up, sign-in and extra passkeys. `/api/join` retired. The custom domain and
  the AASA file.
- Friend links, QR, add/remove/rotate. The friends leaderboard. Friend profiles.
- Sign-up rate limiting and the empty-account sweep.

*Done when:* someone new opens your friend link on a phone, picks a name, uses Face ID or a
fingerprint, and is on your board. You wipe Safari and sign back in.

**M2: the input pattern and the composer, in the PWA.**
- Reps → exercise → configuration → Log. Repeat last set. Repeat session as a queue.
- Creating exercises and variations. Per-exercise stats and boards. Add to mine.
- `/api/compose` with Haiku, caps and the spend ceiling, and the compose fixtures.

*Done when:* the Red Rocks example logs from one sentence, on Android.

**M3: iOS skeleton.**
- `PullupCore` with every fixture passing on Linux. XcodeGen project, GRDB store.
- Passkey sign-up and sign-in, friend links.
- Today screen with the full input pattern, Repeat, undo, edit and delete. Basic stats.
- macOS CI and Xcode Cloud.

*Done when:* TestFlight build 1 replaces the PWA on your phone for a week.

**M4: iOS, everything in.**
- The on-device composer with server fallback. App Intents and Shortcuts.
- Per-exercise stats with Swift Charts.

*Done when:* a mixed session (pull-ups, dips, a front-lever hold, something made up) logs
with no more than one extra tap per exercise change, or one sentence.

**M5: friends on iOS, and the App Store.**
- Board, profiles, Add to mine, share sheet and universal-link friend adds.
- Account deletion, report and block, privacy label. App Store submission.

*Done when:* a friend installs from the App Store and lands on your board.

**M6: logging without opening the app.** Interactive widgets, the Control Center control
and Action button, the Live Activity.

**M7: Apple Watch.** The app, Double Tap repeat, complications, pairing by device link.

**Later:** push notifications, HealthKit, merging duplicate exercises, a native Android app
if the PWA holds Android users back.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Open exercise names carry abuse | Only friends see them. Unfriend is the block. M5 adds report (to the operator) and hide-this-exercise. App Store guideline 1.2 needs both. |
| Duplicate exercises split boards | Search-before-create in the picker and composer. Add to mine. `aliasOf` merging later. |
| The model misreads a description | It only drafts. Every set is shown and editable before logging. Fixtures for regressions. |
| Haiku spend grows with no revenue | Per-user daily cap, monthly ceiling, and the pad always works without it. iOS uses the free on-device model. |
| Junk accounts from open sign-up | WAF rate rule, empty-account sweep. Junk accounts are invisible to users. |
| Losing every device loses the account | Passkeys sync. Device links from another device. Said plainly at sign-up. |
| Two clients (iOS, PWA) to keep current | Shared TS and fixtures carry the logic. The PWA skips platform surfaces. |
| The TS and Swift logic drift | Shared fixtures in both suites. A change to merge, time, stats or resolution isn't done until both pass. |
| A session can't see the UI it wrote | Thin views over `PullupCore`, macOS CI, a per-milestone device checklist. |
| Multi-process SQLite writes | WAL, one transaction per write, an idempotent sync, a two-connection test. |
| Passkeys bound to the wrong domain | Fix the domain in M1, before any registration. |
| Fragment universal links don't open the app | Check on a device in M3. Fallback: a paste field. |
| A stale client strips v2 fields | The protocol gate (§3). |

## 12. Alternatives considered

- **A fixed, curated catalog.** Safer and tidier, and it was this doc's previous plan. But
  "define literally anything and it's on the board" is the product's hook. The catalog
  stays as the built-in starting set.
- **Logging straight from natural language, without a draft.** One fewer tap, but a
  misparse would write wrong data to friends' boards. The draft costs one tap.
- **The model choosing exercise ids.** Fewer moving parts, but ids are opaque strings a
  small model gets wrong, and the on-device model's context can't hold every id.
- **Haiku everywhere, including iOS.** One code path, but it costs money on every call and
  needs a network. The on-device model is free and offline where it exists.
- **Invite-only, one group per deployment.** What exists today. It doesn't grow, and it
  needs an operator to mint invites.
- **Sign in with Apple or Google.** Easier recovery, but it brings in real identity and a
  third party, against "no real identity".
- **CloudKit instead of AWS.** Cross-user queries are awkward in CloudKit, it has no
  Android story, and it would discard a working backend.
- **Game Center leaderboards.** The data, UI and friend graph aren't ours, and custom
  per-exercise boards don't fit.
- **Weighting exercises by difficulty.** Every weight would be arbitrary, and for invented
  exercises impossible. Per-exercise boards and "% of goal" handle fairness instead.

## 13. Open questions

Each has a default the plan assumes. Override any of them.

1. **Does Log stay a separate tap, or does tapping a number log?** Default: a separate Log,
   as in your flow, with Repeat as the one-tap path. The PWA today logs on the number tap.
   Try both in the M2 build.
2. **Does a created exercise counted in reps join the ring?** Default: yes, any exercise
   whose unit is "rep". Steps, laps and holds don't.
3. **Can friends see individual sets?** Default: no, only day totals and per-exercise
   totals and bests.
4. **Should exercises be visible beyond friends** (a public "trending exercises" list)?
   Default: no. It would make this a moderation job.
5. **App Store listing: public or unlisted?** Default: public at M5, since the growth loop
   needs search and links to work.
6. **Units?** Default: weight stored in lb, with a kg display preference.
7. **Default leaderboard ranking?** Default: total reps today, with "% of goal" and the
   exercise filter one tap away.
