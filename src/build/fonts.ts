import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'inherit',
  'initial',
  'unset',
]);

const FONT_EXTS: Record<string, { mime: string; format: string }> = {
  '.woff2': { mime: 'font/woff2', format: 'woff2' },
  '.ttf': { mime: 'font/ttf', format: 'truetype' },
  '.otf': { mime: 'font/otf', format: 'opentype' },
};

export function extractFontFamilies(svgContents: string[]): string[] {
  const families = new Set<string>();
  const attrRegex = /\bfont-family\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  const cssRegex = /\bfont-family\s*:\s*([^;}\n]+)/gi;

  for (const svg of svgContents) {
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(svg)) !== null) {
      const raw = m[1] ?? m[2] ?? '';
      for (const part of raw.split(',')) {
        const clean = part.trim().replace(/^['"]|['"]$/g, '');
        if (clean && !GENERIC_FAMILIES.has(clean.toLowerCase())) {
          families.add(clean);
        }
      }
    }
    while ((m = cssRegex.exec(svg)) !== null) {
      const raw = m[1] ?? '';
      for (const part of raw.split(',')) {
        const clean = part.trim().replace(/^['"]|['"]$/g, '');
        if (clean && !GENERIC_FAMILIES.has(clean.toLowerCase())) {
          families.add(clean);
        }
      }
    }
  }

  return Array.from(families);
}

function normalizeFontName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function walkFontDir(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFontDir(full, out);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (FONT_EXTS[ext]) {
          out.push(full);
        }
      }
    }
  } catch {
    // ignore unreadable directories
  }
}

export function buildEmbeddedFontCss(
  deckDir: string,
  svgContents: string[],
): { css: string; embeddedCount: number } {
  const families = extractFontFamilies(svgContents);
  if (families.length === 0) return { css: '', embeddedCount: 0 };

  const searchDirs = [
    join(deckDir, 'fonts'),
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    join(homedir(), '.local/share/fonts'),
    join(homedir(), '.fonts'),
    '/Library/Fonts',
    join(homedir(), 'Library/Fonts'),
  ];

  const availableFiles: string[] = [];
  for (const dir of searchDirs) {
    walkFontDir(dir, availableFiles);
  }

  if (availableFiles.length === 0) return { css: '', embeddedCount: 0 };

  const rules: string[] = [];
  let embeddedCount = 0;

  for (const family of families) {
    const targetNorm = normalizeFontName(family);
    if (!targetNorm) continue;

    // Prefer woff2 -> ttf -> otf, and prefer exact/regular match
    const candidates = availableFiles.filter((filePath) => {
      const base = filePath.split('/').pop() ?? '';
      const stem = base.slice(0, base.lastIndexOf('.'));
      const norm = normalizeFontName(stem);
      return norm === targetNorm || norm.startsWith(targetNorm);
    });

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const extOrder = (p: string) => {
        const e = extname(p).toLowerCase();
        if (e === '.woff2') return 0;
        if (e === '.ttf') return 1;
        return 2;
      };
      return extOrder(a) - extOrder(b);
    });

    const chosen = candidates[0];
    const ext = extname(chosen).toLowerCase();
    const info = FONT_EXTS[ext];
    if (!info) continue;

    try {
      const b64 = readFileSync(chosen).toString('base64');
      rules.push(
        `@font-face {\n  font-family: "${family.replace(/"/g, '\\"')}";\n  src: url("data:${info.mime};base64,${b64}") format("${info.format}");\n  font-display: swap;\n}`,
      );
      embeddedCount += 1;
    } catch {
      // ignore unreadable font file
    }
  }

  return { css: rules.join('\n'), embeddedCount };
}
