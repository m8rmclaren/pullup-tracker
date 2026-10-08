// Builds the static site into dist/site and the Lambda into dist/lambda.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const siteDir = join(root, 'dist/site');
const lambdaDir = join(root, 'dist/lambda');
const sharedOptions = { logLevel: 'warning', legalComments: 'none' };

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(siteDir, { recursive: true });

const appBuild = await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/app/main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: 'linked',
  format: 'esm',
  target: ['es2022', 'safari16'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outdir: join(siteDir, 'assets'),
  entryNames: 'app-[hash]',
  assetNames: '[name]-[hash]',
  metafile: true,
  define: { __BUILD_ID__: '"__BUILD_ID_PLACEHOLDER__"' },
});

const outputs = Object.keys(appBuild.metafile.outputs).map((outputPath) => relative(siteDir, join(root, outputPath)));
const jsFile = outputs.find((path) => path.endsWith('.js'));
const cssFile = outputs.find((path) => path.endsWith('.css'));

cpSync(join(root, 'public'), siteDir, { recursive: true });
const html = readFileSync(join(root, 'public/index.html'), 'utf8').replace('%JS%', jsFile).replace('%CSS%', cssFile);
writeFileSync(join(siteDir, 'index.html'), html);

// The build id is a hash of everything shipped, so the service worker changes exactly when the app does.
const files = walk(siteDir).filter((path) => !path.endsWith('.map'));
const buildHash = createHash('sha256');
for (const file of files.sort()) buildHash.update(file).update(readFileSync(join(siteDir, file)));
const buildId = buildHash.digest('hex').slice(0, 12);

// Re-stamp the build id into the bundle (it is displayed in Settings).
const jsPath = join(siteDir, jsFile);
writeFileSync(jsPath, readFileSync(jsPath, 'utf8').replaceAll('__BUILD_ID_PLACEHOLDER__', buildId));

await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/app/sw.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022', 'safari16'],
  outfile: join(siteDir, 'sw.js'),
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __PRECACHE__: JSON.stringify(['/', '/index.html', ...files.filter((file) => file !== 'index.html').map((file) => `/${file}`)]),
  },
});

await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/lambda/handler.ts')],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(lambdaDir, 'index.js'),
});

const sizeKb = (path) => (statSync(path).size / 1024).toFixed(1);
console.log(`site   dist/site   build ${buildId}  js ${sizeKb(jsPath)}KB  css ${sizeKb(join(siteDir, cssFile))}KB  files ${files.length}`);
console.log(`lambda dist/lambda/index.js  ${sizeKb(join(lambdaDir, 'index.js'))}KB`);

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}
