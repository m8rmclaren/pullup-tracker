// Local stand-in for CloudFront: serves dist/site and routes /api/* to the real
// handler logic over an in-memory database snapshotted to disk. Not deployed.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createInvite } from '../lambda/accounts';
import { hashToken } from '../lambda/auth';
import { MemoryDb } from '../lambda/db';
import { route } from '../lambda/http';

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
  }
  save() {
    const flat = <V>(byUser: Map<string, Map<string, V>>) => [...byUser].map(([userId, rows]) => [userId, [...rows]]);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dbFile,
      JSON.stringify({ entries: flat(this.entries), dayTotals: flat(this.dayTotals), users: [...this.users], tokens: [...this.tokens], invites: [...this.invites] }),
    );
  }
}

const db = new DiskDb();
db.load();
if (!db.users.has(DEV_USER_ID)) db.users.set(DEV_USER_ID, { id: DEV_USER_ID, name: 'Dev', createdAt: Date.now() });
db.tokens.set(hashToken(DEV_TOKEN), DEV_USER_ID);
const clock = { now: Date.now };
const friendInvite = await createInvite(db, DEV_USER_ID, 'friend', clock);
const devLink = await createInvite(db, DEV_USER_ID, 'device', clock);
db.save();

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
    const apiResponse = await route({ method: request.method ?? 'GET', path: url.pathname, headers: request.headers as Record<string, string>, body }, { db });
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
  console.log(`  join as a new user:  http://localhost:${port}/#join=${friendInvite.code}`);
  console.log(`  sign in as Dev:      http://localhost:${port}/#device=${devLink.code}  (15 min)`);
  console.log(`  curl as Dev:         -H 'x-pullup-token: ${DEV_TOKEN}'`);
});
