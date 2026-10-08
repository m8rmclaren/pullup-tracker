// Builds the static site into dist/site and the Lambda into dist/lambda.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const site = join(root, 'dist/site');
const lambda = join(root, 'dist/lambda');
const watchless = { logLevel: 'warning', legalComments: 'none' };

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(site, { recursive: true });

const app = await build({
  ...watchless,
  entryPoints: [join(root, 'src/app/main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: 'linked',
  format: 'esm',
  target: ['es2022', 'safari16'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outdir: join(site, 'assets'),
  entryNames: 'app-[hash]',
  assetNames: '[name]-[hash]',
  metafile: true,
  define: { __BUILD_ID__: '"__BUILD_ID_PLACEHOLDER__"' },
});

const outputs = Object.keys(app.metafile.outputs).map((p) => relative(site, join(root, p)));
const js = outputs.find((p) => p.endsWith('.js'));
const css = outputs.find((p) => p.endsWith('.css'));

cpSync(join(root, 'public'), site, { recursive: true });
const html = readFileSync(join(root, 'public/index.html'), 'utf8').replace('%JS%', js).replace('%CSS%', css);
writeFileSync(join(site, 'index.html'), html);

// The build id is a hash of everything shipped, so the service worker changes exactly when the app does.
const files = walk(site).filter((p) => !p.endsWith('.map'));
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(f).update(readFileSync(join(site, f)));
const buildId = hash.digest('hex').slice(0, 12);

// Re-stamp the build id into the bundle (it is displayed in Settings).
const jsPath = join(site, js);
writeFileSync(jsPath, readFileSync(jsPath, 'utf8').replaceAll('__BUILD_ID_PLACEHOLDER__', buildId));

await build({
  ...watchless,
  entryPoints: [join(root, 'src/app/sw.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022', 'safari16'],
  outfile: join(site, 'sw.js'),
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __PRECACHE__: JSON.stringify(['/', '/index.html', ...files.filter((f) => f !== 'index.html').map((f) => `/${f}`)]),
  },
});

await build({
  ...watchless,
  entryPoints: [join(root, 'src/lambda/handler.ts')],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(lambda, 'index.js'),
});

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`site   dist/site   build ${buildId}  js ${kb(jsPath)}KB  css ${kb(join(site, css))}KB  files ${files.length}`);
console.log(`lambda dist/lambda/index.js  ${kb(join(lambda, 'index.js'))}KB`);

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)];
  });
}
