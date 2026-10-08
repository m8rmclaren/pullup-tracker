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
const DEV_UID = 'dev';

/** MemoryDb, saved after every write so data survives restarts. */
class DiskDb extends MemoryDb {
  load() {
    if (!existsSync(dbFile)) return;
    const raw = JSON.parse(readFileSync(dbFile, 'utf8')) as Record<string, [string, unknown][]>;
    const nested = (rows: [string, unknown][] = []) => new Map(rows.map(([k, v]) => [k, new Map(v as [string, never][])]));
    this.entries = nested(raw.entries);
    this.days = nested(raw.days);
    this.users = new Map(raw.users as never);
    this.tokens = new Map(raw.tokens as never);
    this.invites = new Map(raw.invites as never);
  }
  save() {
    const flat = <V>(m: Map<string, Map<string, V>>) => [...m].map(([k, v]) => [k, [...v]]);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dbFile,
      JSON.stringify({ entries: flat(this.entries), days: flat(this.days), users: [...this.users], tokens: [...this.tokens], invites: [...this.invites] }),
    );
  }
}

const db = new DiskDb();
db.load();
if (!db.users.has(DEV_UID)) db.users.set(DEV_UID, { id: DEV_UID, name: 'Dev', createdAt: Date.now() });
db.tokens.set(hashToken(DEV_TOKEN), DEV_UID);
const clock = { now: Date.now };
const friendInvite = await createInvite(db, DEV_UID, 'friend', clock);
const devLink = await createInvite(db, DEV_UID, 'device', clock);
db.save();

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const out = await route({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers as Record<string, string>, body }, { db });
    db.save();
    res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out.body));
    return;
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = join(siteDir, rel);
  if (!file.startsWith(siteDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`pull-up tracker dev server on http://localhost:${port}  (data in .devdata/)`);
  console.log(`  join as a new user:  http://localhost:${port}/#join=${friendInvite.code}`);
  console.log(`  sign in as Dev:      http://localhost:${port}/#device=${devLink.code}  (15 min)`);
  console.log(`  curl as Dev:         -H 'x-pullup-token: ${DEV_TOKEN}'`);
});
