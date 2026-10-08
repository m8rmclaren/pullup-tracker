// Builds once, then runs the local dev server (static site + real sync handler).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
await build({
  entryPoints: ['src/dev/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/dev/server.mjs',
  logLevel: 'warning',
});
await import(new URL('../dist/dev/server.mjs', import.meta.url).href);
