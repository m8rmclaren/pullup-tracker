// Local stand-in for CloudFront: serves dist/site and routes /api/* to the real
// handler logic over a directory-backed store. Not deployed.
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { hashToken } from '../lambda/auth';
import { route } from '../lambda/http';
import { MemoryStore, type PutCondition } from '../lambda/store';

const root = process.cwd();
const siteDir = join(root, 'dist/site');
const dataDir = join(root, '.devdata');
const port = Number(process.env.PORT ?? 5173);
export const DEV_TOKEN = process.env.DEV_TOKEN ?? 'dev-token-change-me';

/** MemoryStore semantics, mirrored to disk so data survives restarts. */
class DirStore extends MemoryStore {
  constructor(private dir: string) {
    super();
    if (!existsSync(dir)) return;
    for (const f of walk(dir)) this.objects.set(f, { body: readFileSync(join(dir, f), 'utf8'), etag: `"disk-${statSync(join(dir, f)).mtimeMs}"` });
  }
  override async put(key: string, body: string, cond: PutCondition) {
    const etag = await super.put(key, body, cond);
    mkdirSync(dirname(join(this.dir, key)), { recursive: true });
    writeFileSync(join(this.dir, key), body);
    return etag;
  }
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
}

const store = new DirStore(dataDir);
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
    const out = await route(
      { method: req.method ?? 'GET', path: url.pathname, headers: req.headers as Record<string, string>, body },
      { store, tokenHashes: async () => [hashToken(DEV_TOKEN)] },
    );
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
  console.log(`pull-up tracker dev server on http://localhost:${port}  (sync token: ${DEV_TOKEN}, data in .devdata/)`);
});
