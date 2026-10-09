# Pull-up Tracker — Claude Code Instructions

`README.md` covers the architecture, auth model, data layout and sync protocol. Read the
relevant section there before changing any of them.

## Repository Layout

- `src/app/` — the Preact PWA (UI, localStorage replica, outbox + sync loop, service worker in `sw.ts`)
- `src/lambda/` — the API Lambda: `handler.ts` (Function URL entry), `http.ts` (routing), `db.ts` (the `Db` interface + `MemoryDb`), `dynamodb.ts` (the DynamoDB adapter; its key layout is documented at the top)
- `src/shared/` — model, stats and time code used by both sides
- `src/dev/server.ts` — local dev server: static site + the real router over a disk-backed `MemoryDb`
- `infra/` — Terraform for the app, plus `bootstrap.yaml` (CloudFormation for OIDC trust, deploy role, state bucket)
- `scripts/` — build, dev, deploy, invite tooling
- `test/` — vitest suites

## Commands

| Command | What |
|---|---|
| `npm run dev` | build, then serve on localhost with data in `.devdata/` |
| `npm run build` | bundle site to `dist/site` and Lambda to `dist/lambda` |
| `npm run typecheck` | `tsc` over the app and the service worker config |
| `npm test` | vitest |
| `npm run check` | typecheck + test — run before calling a change done |

## Tests

Most tests are pure. `test/dynamodb.test.ts` runs the adapter against real DynamoDB Local,
because conditions, indexes and transactions are where a fake agrees with itself and is wrong.
It **skips** unless `DYNAMODB_ENDPOINT` is set:

```
docker run --rm -p 8000:8000 amazon/dynamodb-local
DYNAMODB_ENDPOINT=http://localhost:8000 npm test
```

CI (`.github/workflows/pipeline.yml`) sets `DYNAMODB_ENDPOINT`, so those tests are
load-bearing there rather than skipped. Run them locally after any change to `dynamodb.ts`
or `infra/main.tf`'s table definition. The test's `CreateTableCommand` mirrors that
definition, so change both together.

## Code Conventions

- Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.
- Don't explain WHAT the code does. Well-named identifiers already do that. Don't reference the current task, fix, or callers ("used by X", "added for the Y flow"). Those belong in the commit message and go stale as the codebase changes.
- Storage access goes through the `Db` interface in `src/lambda/db.ts`. Route and sync logic never touch the DynamoDB client directly. A new storage operation goes on `Db` and is implemented in both `MemoryDb` and `DynamoDb`.
- Inject time through `Clock` rather than calling `Date.now()` in logic that tests need to control.
- Code under `src/shared/` must run in both the browser and Node. No Node or DOM-only APIs there.

## Naming

Names are full words, not abbreviations. If you find a single letter or abbreviation (`e`, `t`,
`p`, `out`, `uid`, `srv`), rename it in any code you're changing; don't copy it.

- Name things for what they hold, in full words: `entry`, not `e`; `dayTotal`, not `t`; `wallClock`, not `p`; `userId`, not `uid`; `minute`, not `mi`.
- Name a collection in the plural of its element (`entries`, `dayTotals`). Name a function's result for what it is (`liveEntries`, `days`), not `out`, `result` or `res`.
- Put the unit in the name of a number whose unit isn't obvious: `timeoutMs`, `windowDays`, `expiresAtMs`. A bare `ts`, `n` or `window` makes the reader look up the unit.
- Name booleans as predicates: `isDeleted`, `hasGoal`, `canRetry`.
- Name functions for the action they take (`recomputeDayTotals`, `redeemInvite`). Don't use vague verbs like `handle`, `process` or `doX` when a specific one fits.
- Short names are fine only where the scope is a line or two and the meaning is conventional: `i` as a loop index, `a`/`b` in a comparator.
- DynamoDB attribute and index names, `/api/*` JSON fields, and the localStorage state shape are a data format shared with deployed data and installed clients. Name new ones by the same rules, but once the app is deployed, renaming an existing one is a migration (backfill, dual-read, or a cursor reset), not a refactor. `pk` and `sk` stay as they are, by single-table convention.

## Logging Conventions

- The Lambda logs to CloudWatch via `console.*`. Use `console.error` for failures and `console.log` for the rare informational line. Don't log per-request noise on the happy path.
- Write log messages in active voice, saying what is about to happen or what just happened: `` `recomputing day totals for ${userId}` ``, not `"day total recompute"`.
- Interpolate context values inline with template literals. Don't build a message string separately. Pass an `Error` as a trailing argument so its stack is kept.
- Never log tokens, invite codes, or their digests.
