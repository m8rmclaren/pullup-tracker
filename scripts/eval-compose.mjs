// Bundles and runs src/dev/eval-compose.ts: the compose descriptions against the real model. Costs money; not run in CI.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/dev/eval-compose.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/dev/eval-compose.mjs',
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await import(new URL('../dist/dev/eval-compose.mjs', import.meta.url).href);
