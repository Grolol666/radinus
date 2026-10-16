// Bundles the command line into dist/radinus.mjs (src/core is Radinus's own copy; ws stays a dependency): node build.mjs
import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/radinus.mjs',
  // ws is CommonJS and reads its optional parts with require: it stays an import, resolved in node_modules at run time.
  external: ['ws'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
})
