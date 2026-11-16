import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { buildLiveIndexHtml, buildStandalonePresentationHtml } from './src/build/bundler.ts';
import { buildEmbeddedFontCss } from './src/build/fonts.ts';
import { exportDeckToPdf } from './src/build/pdf.ts';
import { composeDeck } from './src/core/compositor.ts';
import { parseSidecarFilename, parseSvgFilename } from './src/core/parser.ts';
import type { DeckData, LayerInput, SidecarInput } from './src/core/types.ts';

interface CliOptions {
  command: string;
  dir: string;
  out: string;
  port: number;
  watch: boolean;
  pdf: boolean;
  lang?: string;
  filters: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let command = 'build';
  let dir = '.';
  let out = '';
  let port = 3000;
  let watchMode = false;
  let pdfMode = false;
  let lang: string | undefined;
  let filters: string[] = [];

  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--watch' || a === '-w') {
      watchMode = true;
    } else if (a === '--pdf') {
      pdfMode = true;
    } else if (a === '--out' || a === '-o') {
      out = args[++i] ?? '';
    } else if (a === '--port' || a === '-p') {
      port = Number.parseInt(args[++i] ?? '3000', 10) || 3000;
    } else if (a === '--lang') {
      lang = args[++i];
    } else if (a === '--filters') {
      const raw = args[++i] ?? '';
      filters = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  if (positional.length > 0 && ['build', 'serve', 'index'].includes(positional[0])) {
    command = positional[0];
    if (positional[1]) dir = positional[1];
  } else if (positional.length > 0) {
    dir = positional[0];
  }

  const absDir = resolve(dir);
  if (!out) {
    out =
      command === 'index'
        ? join(absDir, 'index.html')
        : join(absDir, 'dist', 'presentation.html');
  } else {
    out = resolve(out);
  }

  return {
    command,
    dir: absDir,
    out,
    port,
    watch: watchMode,
    pdf: pdfMode,
    lang,
    filters,
  };
}

function printUsage(): void {
  console.log(`Slidesv CLI — Zero-dependency SVG Presentation Engine

Usage:
  node cli.ts build [dir] [options]   Compile folder into standalone dist/presentation.html
  node cli.ts serve [dir] [--port N]  Start local HTTP dev server with directory listing
  node cli.ts index [dir] [--out P]   Write standalone live-mode index.html

Options:
  --out, -o <path>     Output file path (default: <dir>/dist/presentation.html)
  --watch, -w          Rebuild automatically when SVG/MD/TXT files change
  --pdf                Export presentation to PDF using headless Chromium/Brave
  --lang <code>        Default/export language code (e.g. en, it)
  --filters <a,b>      Comma-separated filter titles/filenames to enable
  --port, -p <port>    Dev server port (default: 3000)
`);
}

function loadDeckFromDisk(targetDir: string): {
  deck: DeckData;
  svgContents: string[];
} {
  const entries = readdirSync(targetDir, { withFileTypes: true });
  const layerInputs: LayerInput[] = [];
  const sidecarInputs: SidecarInput[] = [];
  const svgContents: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(targetDir, entry.name);
    const lower = entry.name.toLowerCase();

    if (lower.endsWith('.svg')) {
      const meta = parseSvgFilename(entry.name);
      if (!meta) continue;
      const svgContent = readFileSync(full, 'utf8');
      svgContents.push(svgContent);
      layerInputs.push({ meta, svgContent });
    } else if (lower.endsWith('.md') || lower.endsWith('.txt')) {
      const meta = parseSidecarFilename(entry.name);
      if (!meta) continue;
      const content = readFileSync(full, 'utf8');
      sidecarInputs.push({ meta, content });
    }
  }

  layerInputs.sort((a, b) => a.meta.filename.localeCompare(b.meta.filename));
  sidecarInputs.sort((a, b) => a.meta.filename.localeCompare(b.meta.filename));

  return {
    deck: composeDeck(layerInputs, sidecarInputs),
    svgContents,
  };
}

function runBuild(opts: CliOptions): void {
  const { deck, svgContents } = loadDeckFromDisk(opts.dir);
  const { css: fontCss, embeddedCount } = buildEmbeddedFontCss(opts.dir, svgContents);

  const html = buildStandalonePresentationHtml(deck, fontCss, {
    lang: opts.lang,
    filters: opts.filters,
  });

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, html, 'utf8');
  console.log(
    `[build] ${opts.out} (${deck.totalSlides} slides, ${deck.languages.length} langs, ${embeddedCount} fonts embedded, ${Math.round(html.length / 1024)} KB)`,
  );

  if (opts.pdf) {
    const pdfPath = opts.out.replace(/\.html?$/i, '') + '.pdf';
    exportDeckToPdf(deck, fontCss, pdfPath, {
      lang: opts.lang,
      filters: opts.filters,
    });
    console.log(`[pdf] Exported ${pdfPath}`);
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function runServe(opts: CliOptions): void {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
    const relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');

    // Serve directory listing at / so live index.html discovers all files,
    // or serve index.html at /index.html
    if (relPath === '') {
      const indexFile = join(opts.dir, 'index.html');
      if (reqUrl.searchParams.get('listing') === '1' || !existsSync(indexFile)) {
        // Fallback listing if no index.html
        const entries = readdirSync(opts.dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => `<li><a href="${encodeURIComponent(e.name)}">${e.name}</a></li>`)
          .join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(`<!DOCTYPE html><html><body><ul>${entries}</ul></body></html>`);
        return;
      }

      // If index.html exists and Accept header or User-Agent is fetch from index.html?
      // Wait: if index.html fetches './', it expects directory listing HTML!
      // Let's check: if index.html is served at `/`, then `fetch('./')` from index.html
      // would receive index.html instead of the directory listing!
      // Unless we serve directory listing when `Sec-Fetch-Dest` != 'document' or `Accept` doesn't prefer text/html,
      // OR we serve live index.html at `/index.html` and redirect `/` -> `/index.html`?
      // Wait: if we redirect `/` -> `/index.html`, then `fetch('./')` from `/index.html` still hits `/`!
      // So if `/` checks: if request is a browser navigation (`Sec-Fetch-Mode: navigate` or no `X-Requested-With` and `Accept` includes `text/html`), serve `index.html`;
      // Wait: `fetch('./')` in browser also has `Accept: */*` (NOT `text/html`!) whereas browser page load has `Accept: text/html,...`!
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/html')) {
        const html = readFileSync(indexFile, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      const entries = readdirSync(opts.dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => `<li><a href="${encodeURIComponent(e.name)}">${e.name}</a></li>`)
        .join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!DOCTYPE html><html><body><ul>${entries}</ul></body></html>`);
      return;
    }

    const safePath = resolve(opts.dir, relPath);
    if (!safePath.startsWith(opts.dir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(safePath) || !statSync(safePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const st = statSync(safePath);
    const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const lastMod = st.mtime.toUTCString();
    const ext = extname(safePath).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'ETag': etag,
      'Last-Modified': lastMod,
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(readFileSync(safePath));
  });

  server.listen(opts.port, () => {
    console.log(`Slidesv dev server listening at http://localhost:${opts.port}/`);
    console.log(`Serving directory: ${opts.dir}`);
  });
}

function main(): void {
  const opts = parseArgs(process.argv);

  if (opts.command === 'index') {
    const html = buildLiveIndexHtml();
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, html, 'utf8');
    console.log(`[index] Wrote ${opts.out}`);
    return;
  }

  if (opts.command === 'serve') {
    runServe(opts);
    return;
  }

  runBuild(opts);

  if (opts.watch) {
    console.log(`[watch] Watching ${opts.dir} for changes...`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    watch(opts.dir, (_event, filename) => {
      if (!filename) return;
      const lower = filename.toLowerCase();
      if (
        !lower.endsWith('.svg') &&
        !lower.endsWith('.md') &&
        !lower.endsWith('.txt')
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          runBuild(opts);
        } catch (err) {
          console.error('[watch] Build error:', err);
        }
      }, 150);
    });
  }
}

main();
