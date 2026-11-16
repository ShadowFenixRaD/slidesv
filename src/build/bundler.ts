import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeckData } from '../core/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../..');

const BROWSER_MODULES = [
  'src/core/types.ts',
  'src/core/parser.ts',
  'src/core/compositor.ts',
  'src/player/tools.ts',
  'src/player/presenter.ts',
  'src/player/runtime.ts',
  'src/player/entry.ts',
];

function stripImportsAndExports(jsCode: string): string {
  // Remove single-line and multi-line import statements
  let out = jsCode.replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');

  // Remove export keywords on declarations
  out = out.replace(
    /^(\s*)export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm,
    '$1',
  );
  // Remove `export { ... };` lines
  out = out.replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
  return out;
}

export function compileBrowserBundle(): { js: string; css: string } {
  const parts: string[] = [];

  for (const relPath of BROWSER_MODULES) {
    const absPath = join(PROJECT_ROOT, relPath);
    const tsSource = readFileSync(absPath, 'utf8');
    const stripped = stripTypeScriptTypes(tsSource, { mode: 'strip' });
    const cleaned = stripImportsAndExports(stripped);
    parts.push(`// --- ${relPath} ---\n${cleaned}`);
  }

  const js = `(() => {\n'use strict';\n${parts.join('\n\n')}\n})();`;
  const css = readFileSync(join(PROJECT_ROOT, 'src/player/styles.css'), 'utf8');
  return { js, css };
}

function escapeJsonForScript(obj: unknown): string {
  return JSON.stringify(obj).replace(/<\/script/gi, '<\\/script');
}

export function buildLiveIndexHtml(): string {
  const { js, css } = compileBrowserBundle();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Slidesv — Live Presentation</title>
  <style>${css}</style>
</head>
<body>
  <div style="padding:2rem;font-family:system-ui,sans-serif;color:#9aa5b8;">Loading presentation...</div>
  <script>${js}</script>
</body>
</html>
`;
}

export function buildStandalonePresentationHtml(
  deck: DeckData,
  fontCss: string,
  config?: { lang?: string; filters?: string[]; skipStarter?: boolean },
): string {
  const { js, css } = compileBrowserBundle();
  const deckJson = escapeJsonForScript(deck);
  const cfgJson = escapeJsonForScript(config ?? {});

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Slidesv — ${deck.totalSlides} Slides</title>
  <style>${fontCss ? `${fontCss}\n` : ''}${css}</style>
</head>
<body>
  <script>
    window.__SLIDESV_DECK__ = ${deckJson};
    window.__SLIDESV_CONFIG__ = ${cfgJson};
  </script>
  <script>${js}</script>
</body>
</html>
`;
}
