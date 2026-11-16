import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ComposedLayer, DeckData } from '../core/types.ts';

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH ?? '',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'brave-browser',
  'brave',
].filter(Boolean);

export function findHeadlessBrowser(): string | null {
  for (const bin of BROWSER_CANDIDATES) {
    const res = spawnSync('which', [bin], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim().split('\n')[0];
    }
  }
  return null;
}

function isLayerActiveForPdf(
  layer: ComposedLayer,
  step: number,
  lang: string,
  filterSet: Set<string>,
  groupChoices: Record<string, string>,
): boolean {
  const { meta } = layer;
  if (meta.step > step) return false;
  if (meta.languages.length > 0 && lang && !meta.languages.includes(lang)) {
    return false;
  }
  if (meta.group !== null) {
    return groupChoices[meta.group] === meta.filename;
  }
  if (meta.shortcuts.length > 0) {
    return (
      filterSet.has(meta.filename.toLowerCase()) ||
      filterSet.has(meta.title.toLowerCase()) ||
      meta.isDefault
    );
  }
  return true;
}

function applySwitchLanguageMarkup(svgMarkup: string, lang: string): string {
  if (!lang) return svgMarkup;
  // Simple static evaluation of <switch> blocks for PDF output
  return svgMarkup.replace(/<switch\b[^>]*>([\s\S]*?)<\/switch>/gi, (_full, inner: string) => {
    const childRegex = /<([A-Za-z_][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>|<([A-Za-z_][\w:-]*)\b([^>]*)\/>/g;
    const children: Array<{ raw: string; langAttr: string | null }> = [];
    let m: RegExpExecArray | null;
    while ((m = childRegex.exec(inner)) !== null) {
      const attrs = m[2] ?? m[5] ?? '';
      const langMatch = attrs.match(/\bdata-system-language\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const langAttr = langMatch ? (langMatch[1] ?? langMatch[2] ?? '') : null;
      children.push({ raw: m[0], langAttr });
    }
    if (children.length === 0) return inner;

    const targetBase = lang.toLowerCase().split('-')[0];
    const matched = children.find((c) => {
      if (c.langAttr === null) return false;
      return c.langAttr
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .some((code) => code === lang.toLowerCase() || code.split('-')[0] === targetBase);
    });
    const fallback = children.find((c) => c.langAttr === null);
    const winner = matched ?? fallback;
    return winner ? winner.raw : '';
  });
}

export function exportDeckToPdf(
  deck: DeckData,
  fontCss: string,
  pdfOutputPath: string,
  options: { lang?: string; filters?: string[] } = {},
): void {
  const browser = findHeadlessBrowser();
  if (!browser) {
    throw new Error(
      'No headless Chromium/Chrome/Brave binary found in PATH (or CHROME_PATH). Install chromium/google-chrome/brave-browser to use --pdf.',
    );
  }

  const lang = (options.lang ?? deck.languages[0] ?? '').toLowerCase();
  const filterSet = new Set(
    (options.filters ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean),
  );

  const groupChoices: Record<string, string> = {};
  for (const g of deck.groups) {
    const matched = g.options.find(
      (o) =>
        filterSet.has(o.layerKey.toLowerCase()) ||
        filterSet.has(o.title.toLowerCase()),
    );
    const def = matched ?? g.options.find((o) => o.isDefault) ?? g.options[0];
    if (def) groupChoices[g.name] = def.layerKey;
  }

  const pagesHtml: string[] = [];
  for (const slide of deck.slides) {
    for (let step = 0; step <= slide.maxStep; step += 1) {
      const visibleLayers = slide.layers
        .filter((l) => isLayerActiveForPdf(l, step, lang, filterSet, groupChoices))
        .map(
          (l) =>
            `<div class="pdf-layer">${applySwitchLanguageMarkup(l.svgMarkup, lang)}</div>`,
        )
        .join('\n');
      pagesHtml.push(`<div class="pdf-page">${visibleLayers}</div>`);
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    ${fontCss}
    @page { size: 1280px 720px; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #000; }
    .pdf-page {
      width: 1280px;
      height: 720px;
      display: grid;
      place-items: center;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
      background: #000;
    }
    .pdf-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .pdf-layer {
      grid-area: 1 / 1;
      width: 1280px;
      height: 720px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pdf-layer > svg {
      width: 100%;
      height: 100%;
      display: block;
    }
  </style>
</head>
<body>
  ${pagesHtml.join('\n')}
</body>
</html>`;

  const tmpDir = mkdtempSync(join(tmpdir(), 'slidesv-pdf-'));
  const tmpHtml = join(tmpDir, 'print.html');
  const absPdf = resolve(pdfOutputPath);
  mkdirSync(dirname(absPdf), { recursive: true });

  try {
    writeFileSync(tmpHtml, html, 'utf8');
    execFileSync(
      browser,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        `--print-to-pdf=${absPdf}`,
        '--print-to-pdf-no-header',
        `file://${tmpHtml}`,
      ],
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
