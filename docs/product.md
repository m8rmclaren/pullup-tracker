# Pull-up Tracker v2: product

Status: **draft**, revised 2026-10-12. Screens and interactions are deliberately left
loose. They are cheaper to find by using a build than by specifying them here.

The v2 design is three docs, split by how often they change:

- [product.md](product.md): what the app is, the growth loop, milestones and open
  questions. Changes often.
- [v2-design.md](v2-design.md): data formats, the API, auth and the composer. The
  decisions that are expensive to reverse. Changes rarely.
- [ios.md](ios.md): the native iOS app's architecture, platform surfaces, build and
  release. Not needed until after the M2 checkpoint.

## Summary

The app grows from a pull-up log into a log for **any movement anyone can describe**, and
gains a native iOS app. The app does two things, both as simply as possible: it gets data
in, and it shows stats.

- **One input pattern for everything:** reps, then exercise, then configuration, then Log.
  The exercise and configuration are prefilled from your history, so the common case is a
  number and Log. Repeating a set or a whole session is one tap.
- **Describe anything.** Type or say what you did ("3 laps of the Red Rocks stairs, 20
  push-ups at the top each time"). A language model composes it into sets for you to
  confirm. The server calls Claude Haiku for every client. Apple's on-device model can
  take over on iOS later.
- **Exercises are open.** Anyone can define an exercise or a variation, and the backend
  stores it at face value. Your exercises show up on your friends' leaderboards and on your
  profile. This is the hook.
- **Sign-up is a name and a passkey.** No email, no phone, no invite. Free forever, with
  no monetization.
- **Friends are a graph, and links are the way in.** A friend link adds you. A challenge
  link adds you and drops you onto a board for one exercise. Link kinds are data, so the
  growth loop can be tuned without a migration.
- **Leaderboards are client-side views.** The server returns raw day totals and never
  ranks. A board is a small spec (metric, exercise, period), so ranking can be tuned in a
  client release.

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
| Ring | Sums counted sets whose unit is **rep**. Other units and holds show per exercise, not on the ring. |
| Natural language | Composes a **draft** of sets that you confirm. It never logs directly. |
| Sign-up | Open. A display name, then a passkey. No account exists without a passkey. |
| Friends | Mutual. Made by opening a link. |
| Visibility | Friends see your profile, day totals and exercise definitions. Never individual sets. |
| Android | The PWA, kept current. Passkeys work through Google Password Manager. |
| iOS distribution | TestFlight while building. The App Store once friends and profiles land (open sign-up makes it viable). |

## Product shape

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

- **Links are the way in** (`https://<domain>/#join=<code>`, also a QR code). The code
  resolves on the server to a stored payload, and the payload's `kind` decides where you
  land. Two kinds to start:
  - **Friend link:** your personal, reusable link. Opening it makes you friends.
  - **Challenge link:** a friend link plus a board. "Red Rocks stairs, this month." Opening
    it makes you friends, adds the exercise to your picker under the same id, and opens on
    that board. The person arrives with a reason to log, and on the same id as everyone
    else, so the board doesn't split.

  Before sign-up, the landing page shows what the link is ("Hayden challenged you: Red
  Rocks stairs, this month") from an unauthenticated resolve. Someone who isn't signed up
  picks a name, creates a passkey, and lands in the same place when it finishes.
- **Leaderboards** cover you and your friends. A board is a spec: a metric, an optional
  exercise, and a period. Metrics to start: count in the exercise's unit, sets, best set,
  active days, % of goal. Periods: today, this week, this month, or a challenge's fixed
  window. "Red Rocks stairs, this month" is a board as soon as two friends have logged it.
  Which board is the default is open (see Open questions). Total reps across exercises is easy to game
  with easy reps, so it is one option, not the headline.
- **Profiles:** a friend's ring, streak, their exercises with totals and bests, and their
  recent days. Tapping one of their exercises offers **Add to mine**, which puts it in your
  picker under the same id, so you both land on the same board. This is how invented
  exercises spread.

## The PWA

The PWA is the Android and web client, so it no longer freezes. It keeps the same input
pattern and the same features as iOS, minus what needs the platform: widgets, Live
Activities and the Watch. Its composer is the same `/api/compose` as iOS.

Keeping two clients current is the cost of Android without a native app. The shared TS
code (`model`, `time`, `stats`, the resolver) is most of the logic, so the PWA's extra work
is mostly UI.

## Milestones

Each milestone ends in something you can use. M0–M2 are server and PWA work that cloud
sessions can do start to finish. They also make Android and web fully usable before any
Swift exists.

**M0: model v2.**
- Shared fixtures, `catalog.json`, per-user time zones (existing users on Denver).
- The v2 entry, created exercises and variations, definitions in sync.
- Day totals with `byExercise` and the rep-unit ring rule, holding every field the first
  board metrics need.
- The protocol gate, with the PWA sending v2.
- The profile fields and `/api/profile`.

*Done when:* `npm run check` and the DynamoDB suite are green and deployed, and old data
reads the same.

**M1: open sign-up and friends.**
- Passkey sign-up, sign-in and extra passkeys. `/api/join` retired. The AASA file, on
  `pullups.haydenroszell.com` until the final domain is bought.
- Links: friend links and challenge links, QR, resolve and redeem, rotate. The landing page
  that shows what a link is before sign-up. `openCount`, `joinCount`, `joinedVia`.
- The friends leaderboard as board specs, with `boards.json`. Friend profiles. Remove friend.
- Sign-up rate limiting and the empty-account sweep.

*Done when:* someone new opens your challenge link on a phone, picks a name, uses Face ID or a
fingerprint, and lands on that challenge's board. You wipe Safari and sign back in.

**M2: the input pattern and the composer, in the PWA.**
- Reps → exercise → configuration → Log. Repeat last set. Repeat session as a queue.
- Creating exercises and variations. Per-exercise stats and boards. Add to mine.
- `/api/compose` with Haiku, caps and the spend ceiling, and the compose fixtures.

*Done when:* the Red Rocks example logs from one sentence, on Android.

**Checkpoint: does the loop work?** M0–M2 are a complete test of the product on Android
and iOS Safari: open sign-up, links, invented exercises, boards and Describe. Before
starting M3, which begins most of the remaining effort, check the link counters: do
challenge links get opened, do opens become accounts, and do those accounts make links of
their own? Tune link kinds and boards here, where a change is a deploy. The final domain
must be in place before links go to anyone.

**M3: iOS skeleton.**
- `PullupCore` with every fixture passing on Linux. XcodeGen project, GRDB store.
- Passkey sign-up and sign-in, link redemption.
- Today screen with the full input pattern, Repeat, undo, edit and delete. Basic stats.
- macOS CI and Xcode Cloud.

*Done when:* TestFlight build 1 replaces the PWA on your phone for a week.

**M4: iOS, everything in.**
- The composer UI over `/api/compose`. App Intents and Shortcuts.
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

**You'll need to provide:** the Apple Developer Program membership ($99 a year), a bundle
id and App Group, the final domain, an Anthropic API key for `/api/compose`, and Swift in
this environment's setup script.

## Risks

| Risk | Mitigation |
|---|---|
| Open exercise names carry abuse | Only friends see them. Unfriend is the block. M5 adds report (to the operator) and hide-this-exercise. App Store guideline 1.2 needs both. |
| Duplicate exercises split boards | Search-before-create in the picker and composer. Add to mine. `aliasOf` merging later. |
| The model misreads a description | It only drafts. Every set is shown and editable before logging. Fixtures for regressions. |
| Haiku spend grows with no revenue | Per-user daily cap, monthly ceiling, and the pad always works without it. The on-device model on iOS later, if needed. |
| Junk accounts from open sign-up | WAF rate rule, empty-account sweep. Junk accounts are invisible to users. |
| Losing every device loses the account | Passkeys sync. Device links from another device. Said plainly at sign-up. |
| Two clients (iOS, PWA) to keep current | Shared TS and fixtures carry the logic. The PWA skips platform surfaces. |
| The growth loop doesn't take | Link counters and `joinedVia` measure it. The M2 checkpoint comes before the iOS investment. Link kinds and board specs tune it without a migration. |

## Alternatives considered

- **A fixed, curated catalog.** Safer and tidier, and it was this doc's previous plan. But
  "define literally anything and it's on the board" is the product's hook. The catalog
  stays as the built-in starting set.
- **Logging straight from natural language, without a draft.** One fewer tap, but a
  misparse would write wrong data to friends' boards. The draft costs one tap.
- **Invite-only, one group per deployment.** What exists today. It doesn't grow, and it
  needs an operator to mint invites.
- **Sign in with Apple or Google.** Easier recovery, but it brings in real identity and a
  third party, against "no real identity".
- **Game Center leaderboards.** The data, UI and friend graph aren't ours, and custom
  per-exercise boards don't fit.
- **Weighting exercises by difficulty.** Every weight would be arbitrary, and for invented
  exercises impossible. Per-exercise boards and "% of goal" handle fairness instead.

## Open questions

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
7. **Default board?** Total reps is easy to game with easy reps, and "% of goal" with a low
   goal. Default to try: the exercise most of you and your friends logged this week, by
   count. Needs a deeper look, which board specs leave room for.
8. **What does a challenge look like beyond one exercise and a window?** A target ("1,000
   push-ups in October"), a group board for everyone who joined, a challenge to someone
   who isn't your friend yet? Default: one exercise and a window, to start. New shapes are
   new link kinds and board fields.
9. **The product's name and final domain.** Default: `pullups.haydenroszell.com` until
   it's bought, and the move happens before the M2 checkpoint.
