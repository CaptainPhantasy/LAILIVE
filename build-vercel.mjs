import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Vercel serves only public assets. The Sites Worker stays in dist/server.
const source = path.resolve('dist');
const target = path.resolve('.vercel-static');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of readdirSync(source)) {
  if (entry === 'server' || entry === 'design.css') continue;
  cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
}
console.log('Prepared Vercel public assets; Board uses the native /api/board function.');
