// Local stand-in for CloudFront: serves dist/site and routes /api/* to the real
// handler logic over an in-memory database snapshotted to disk. Not deployed.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createDeviceLink } from '../lambda/accounts';
import { hashToken } from '../lambda/auth';
import { bedrockComposer } from '../lambda/bedrock';
import { MemoryDb } from '../lambda/db';
import { route } from '../lambda/http';
import { patternComposer } from './composer';

const root = process.cwd();
const siteDir = join(root, 'dist/site');
const dataDir = join(root, '.devdata');
const dbFile = join(dataDir, 'db.json');
const port = Number(process.env.PORT ?? 5173);
export const DEV_TOKEN = process.env.DEV_TOKEN ?? 'dev-token-change-me';
const DEV_USER_ID = 'dev';

/** MemoryDb, saved after every write so data survives restarts. */
class DiskDb extends MemoryDb {
  load() {
    if (!existsSync(dbFile)) return;
    const snapshot = JSON.parse(readFileSync(dbFile, 'utf8')) as Record<string, [string, unknown][]>;
    const nested = (rows: [string, unknown][] = []) => new Map(rows.map(([userId, userRows]) => [userId, new Map(userRows as [string, never][])]));
    this.entries = nested(snapshot.entries);
    this.dayTotals = nested(snapshot.dayTotals);
    this.users = new Map(snapshot.users as never);
    this.tokens = new Map(snapshot.tokens as never);
    this.invites = new Map(snapshot.invites as never);
    this.definitions = new Map(snapshot.definitions as never);
    this.adoptions = nested(snapshot.adoptions);
    this.pendingChallenges = new Map(snapshot.pendingChallenges as never);
    this.challenges = new Map(snapshot.challenges as never);
    this.memberships = nested(snapshot.memberships);
    this.passkeys = nested(snapshot.passkeys);
    this.sweepMarkers = new Map((snapshot.sweepMarkers ?? []).map(([day, userIds]) => [day, new Set(userIds as string[])]));
    this.links = new Map(snapshot.links as never);
    this.friendLinks = new Map(snapshot.friendLinks as never);
    this.friendships = nested(snapshot.friendships);
  }
  save() {
    const flat = <V>(byUser: Map<string, Map<string, V>>) => [...byUser].map(([userId, rows]) => [userId, [...rows]]);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dbFile,
      JSON.stringify({
        entries: flat(this.entries),
        dayTotals: flat(this.dayTotals),
        users: [...this.users],
        tokens: [...this.tokens],
        invites: [...this.invites],
        definitions: [...this.definitions],
        adoptions: flat(this.adoptions),
        pendingChallenges: [...this.pendingChallenges],
        challenges: [...this.challenges],
        memberships: flat(this.memberships),
        passkeys: flat(this.passkeys),
        sweepMarkers: [...this.sweepMarkers].map(([day, userIds]) => [day, [...userIds]]),
        links: [...this.links],
        friendLinks: [...this.friendLinks],
        friendships: flat(this.friendships),
      }),
    );
  }
}

const db = new DiskDb();
db.load();
if (!db.users.has(DEV_USER_ID)) db.users.set(DEV_USER_ID, { id: DEV_USER_ID, name: 'Dev', createdAt: Date.now() });
db.tokens.set(hashToken(DEV_TOKEN), DEV_USER_ID);
const clock = { now: Date.now };
const devLink = await createDeviceLink(db, DEV_USER_ID, clock);
db.save();
// Passkeys need a domain, and an IP address isn't one, so they work on localhost but not on 127.0.0.1.
const webAuthn = { rpId: 'localhost', rpName: 'Pull-ups (dev)', origins: [`http://localhost:${port}`] };
// COMPOSE_MODEL_ID (and AWS credentials) uses Bedrock as the Lambda does; otherwise a pattern reader stands in.
const devCompose = {
  composer: process.env.COMPOSE_MODEL_ID ? bedrockComposer({ region: process.env.AWS_REGION ?? 'us-west-2', modelId: process.env.COMPOSE_MODEL_ID }) : patternComposer,
  monthlyCeilingUsd: 1,
  inputUsdPerMillionTokens: 0.1,
  outputUsdPerMillionTokens: 0.5,
};

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const apiResponse = await route({ method: request.method ?? 'GET', path: url.pathname, headers: request.headers as Record<string, string>, body }, { db, webAuthn, isSignupOpen: true, compose: devCompose });
    db.save();
    response.writeHead(apiResponse.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(apiResponse.body));
    return;
  }
  const relativePath = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = join(siteDir, relativePath);
  if (!file.startsWith(siteDir) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`pull-up tracker dev server on http://localhost:${port}  (data in .devdata/)`);
  console.log(`  sign up:             http://localhost:${port}/  (Settings → Create an account; passkeys need localhost)`);
  console.log(`  sign in as Dev:      http://localhost:${port}/#device=${devLink.code}  (15 min)`);
  console.log(`  curl as Dev:         -H 'x-pullup-token: ${DEV_TOKEN}'`);
});
