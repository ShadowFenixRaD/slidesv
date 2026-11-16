import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildLiveIndexHtml } from '../src/build/bundler.ts';

const rootDir = resolve('.');
const html = buildLiveIndexHtml();
const rootIndex = join(rootDir, 'index.html');
writeFileSync(rootIndex, html, 'utf8');
console.log(`Generated standalone live runtime: ${rootIndex} (${html.length} bytes)`);

const demoDir = join(rootDir, 'demo-deck');
if (existsSync(demoDir)) {
  const demoIndex = join(demoDir, 'index.html');
  writeFileSync(demoIndex, html, 'utf8');
  console.log(`Updated demo-deck runtime: ${demoIndex}`);
}
