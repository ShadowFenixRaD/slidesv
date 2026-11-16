import { composeDeck } from '../core/compositor.ts';
import { parseSidecarFilename, parseSvgFilename } from '../core/parser.ts';
import type { DeckData, LayerInput, SidecarInput } from '../core/types.ts';
import { SlidePlayer } from './runtime.ts';

declare global {
  interface Window {
    __SLIDESV_DECK__?: DeckData;
    __SLIDESV_CONFIG__?: {
      lang?: string;
      filters?: string[];
      skipStarter?: boolean;
    };
  }
}

interface DiscoveredFiles {
  svgs: string[];
  sidecars: string[];
}

function extractFilesFromDirectoryHtml(html: string): DiscoveredFiles {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = Array.from(doc.querySelectorAll('a[href]'));
  const svgSet = new Set<string>();
  const sidecarSet = new Set<string>();

  for (const a of links) {
    const rawHref = a.getAttribute('href') ?? '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('?')) continue;

    let clean = rawHref.split('?')[0].split('#')[0];
    if (clean.endsWith('/')) continue;

    // Handle absolute or relative hrefs pointing to current directory
    try {
      const resolved = new URL(clean, window.location.href);
      if (resolved.origin !== window.location.origin) continue;
      const baseDir = window.location.pathname.replace(/[^/]*$/, '');
      if (!resolved.pathname.startsWith(baseDir)) continue;
      const rel = resolved.pathname.slice(baseDir.length);
      if (rel.includes('/')) continue;
      clean = decodeURIComponent(rel);
    } catch {
      if (clean.includes('/')) continue;
    }

    const lower = clean.toLowerCase();
    if (lower.endsWith('.svg')) svgSet.add(clean);
    else if (lower.endsWith('.md') || lower.endsWith('.txt')) sidecarSet.add(clean);
  }

  return {
    svgs: Array.from(svgSet).sort(),
    sidecars: Array.from(sidecarSet).sort(),
  };
}

async function discoverDirectoryFiles(): Promise<DiscoveredFiles> {
  const res = await fetch('./', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to list directory: ${res.status}`);
  }
  const html = await res.text();
  return extractFilesFromDirectoryHtml(html);
}

async function fetchDeckFromDirectory(): Promise<{
  deck: DeckData;
  stamps: Map<string, string>;
}> {
  const { svgs, sidecars } = await discoverDirectoryFiles();
  const stamps = new Map<string, string>();
  const layerInputs: LayerInput[] = [];
  const sidecarInputs: SidecarInput[] = [];

  await Promise.all([
    ...svgs.map(async (file) => {
      const meta = parseSvgFilename(file);
      if (!meta) return;
      const res = await fetch(encodeURIComponent(file), { cache: 'no-store' });
      if (!res.ok) return;
      const stamp = `${res.headers.get('etag') ?? ''}|${res.headers.get('last-modified') ?? ''}`;
      stamps.set(file, stamp);
      const svgContent = await res.text();
      layerInputs.push({ meta, svgContent });
    }),
    ...sidecars.map(async (file) => {
      const meta = parseSidecarFilename(file);
      if (!meta) return;
      const res = await fetch(encodeURIComponent(file), { cache: 'no-store' });
      if (!res.ok) return;
      const stamp = `${res.headers.get('etag') ?? ''}|${res.headers.get('last-modified') ?? ''}`;
      stamps.set(file, stamp);
      const content = await res.text();
      sidecarInputs.push({ meta, content });
    }),
  ]);

  layerInputs.sort((a, b) => a.meta.filename.localeCompare(b.meta.filename));
  sidecarInputs.sort((a, b) => a.meta.filename.localeCompare(b.meta.filename));

  return {
    deck: composeDeck(layerInputs, sidecarInputs),
    stamps,
  };
}

async function checkForChanges(stamps: Map<string, string>): Promise<boolean> {
  try {
    const { svgs, sidecars } = await discoverDirectoryFiles();
    const allFiles = [...svgs, ...sidecars];
    if (allFiles.length !== stamps.size) return true;
    for (const f of allFiles) {
      if (!stamps.has(f)) return true;
    }

    const checks = await Promise.all(
      allFiles.map(async (file) => {
        const res = await fetch(encodeURIComponent(file), {
          method: 'HEAD',
          cache: 'no-store',
        });
        if (!res.ok) return true;
        const stamp = `${res.headers.get('etag') ?? ''}|${res.headers.get('last-modified') ?? ''}`;
        return stamp !== stamps.get(file);
      }),
    );

    return checks.some(Boolean);
  } catch {
    return false;
  }
}

async function bootstrap(): Promise<void> {
  if (window.__SLIDESV_DECK__) {
    const cfg = window.__SLIDESV_CONFIG__ ?? {};
    new SlidePlayer(
      window.__SLIDESV_DECK__,
      cfg.lang,
      cfg.filters,
      cfg.skipStarter,
    );
    return;
  }

  try {
    let { deck, stamps } = await fetchDeckFromDirectory();
    const player = new SlidePlayer(deck);

    setInterval(async () => {
      const changed = await checkForChanges(stamps);
      if (changed) {
        try {
          const updated = await fetchDeckFromDirectory();
          stamps = updated.stamps;
          player.updateDeck(updated.deck);
        } catch {
          // ignore transient reload error
        }
      }
    }, 500);
  } catch (err) {
    document.body.innerHTML = `
      <div style="padding:2rem;font-family:system-ui,sans-serif;color:#eef2f8;">
        <h2>Slidesv Live Mode</h2>
        <p>Could not auto-discover SVG files in the current directory.</p>
        <p style="color:#9aa5b8;">Serve this folder over HTTP (e.g. <code>node cli.ts serve</code>, <code>python3 -m http.server</code>, or <code>npx serve</code>).</p>
        <pre style="color:#ef4444;">${String(err)}</pre>
      </div>
    `;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
