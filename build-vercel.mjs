import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Vercel serves only public assets; the site is deployed exclusively there.
const source = path.resolve('dist');
const target = path.resolve('.vercel-static');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of readdirSync(source)) {
  if (entry === 'design.css') continue;
  cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
}
console.log('Prepared Vercel public assets; Board uses the native /api/board function.');

await build({ entryPoints: ['src/owner/app.js'], outfile: '.vercel-static/owner/app.js', bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
