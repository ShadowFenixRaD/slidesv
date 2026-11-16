import type {
  LayerBand,
  ParsedLayerMeta,
  ParsedSelector,
  ParsedShortcut,
  ParsedSidecarMeta,
  SelectorRange,
  TransitionType,
} from './types.ts';

const SELECTOR_REGEX = /^!?(\d+(_\d+)?)(,!?(\d+(_\d+)?))*$/;
const VALID_TRANSITIONS = new Set<string>(['fade', 'slide', 'zoom', 'none']);
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  win: 'meta',
  meta: 'meta',
  cmd: 'meta',
  super: 'meta',
};

export function parseSelector(token: string): ParsedSelector {
  const parts = token.split(',');
  const ranges: SelectorRange[] = [];
  let hasPositive = false;

  for (const rawPart of parts) {
    const negate = rawPart.startsWith('!');
    const clean = negate ? rawPart.slice(1) : rawPart;
    const [aStr, bStr] = clean.split('_');
    const a = Number.parseInt(aStr, 10);
    const b = bStr !== undefined ? Number.parseInt(bStr, 10) : a;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (!negate) {
      hasPositive = true;
    }
    ranges.push({ start, end, negate });
  }

  return {
    raw: token,
    ranges,
    hasPositive,
    isGlobal: false,
  };
}

export function createGlobalSelector(): ParsedSelector {
  return {
    raw: '',
    ranges: [],
    hasPositive: false,
    isGlobal: true,
  };
}

export function matchesSlide(selector: ParsedSelector, slideNumber: number): boolean {
  if (slideNumber < 1) return false;
  if (selector.isGlobal) return true;

  let included = !selector.hasPositive;
  if (selector.hasPositive) {
    for (const r of selector.ranges) {
      if (!r.negate && slideNumber >= r.start && slideNumber <= r.end) {
        included = true;
        break;
      }
    }
  }

  if (!included) return false;

  for (const r of selector.ranges) {
    if (r.negate && slideNumber >= r.start && slideNumber <= r.end) {
      return false;
    }
  }

  return true;
}

export function parseShortcutToken(token: string): ParsedShortcut | null {
  if (!token.startsWith('s_')) return null;
  const parts = token
    .slice(2)
    .split('_')
    .map((p) => p.toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const key = parts[parts.length - 1];
  const rawMods = parts.slice(0, -1);
  const modifiers: string[] = [];
  for (const m of rawMods) {
    const normalized = MODIFIER_ALIASES[m] ?? m;
    if (!modifiers.includes(normalized)) {
      modifiers.push(normalized);
    }
  }

  const orderedMods = ['ctrl', 'alt', 'shift', 'meta'].filter((m) =>
    modifiers.includes(m),
  );
  const extraMods = modifiers.filter((m) => !orderedMods.includes(m));
  const finalMods = [...orderedMods, ...extraMods];

  const display = [...rawMods, key].join('+');
  const signature = [...finalMods, key].join('+');

  return {
    raw: token,
    modifiers: finalMods,
    key,
    display,
    signature,
  };
}

export function basenameOf(filepath: string): string {
  const clean = filepath.split('?')[0].split('#')[0];
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function parseSvgFilename(filepath: string): ParsedLayerMeta | null {
  const filename = basenameOf(filepath);
  if (!filename.toLowerCase().endsWith('.svg')) return null;

  const stem = filename.slice(0, -4);
  if (!stem) return null;

  const tokens = stem.split('-');
  let cursor = 0;

  let selector: ParsedSelector;
  if (SELECTOR_REGEX.test(tokens[0])) {
    selector = parseSelector(tokens[0]);
    cursor = 1;
  } else {
    selector = createGlobalSelector();
  }

  const rawTitle = tokens[cursor] ?? 'untitled';
  const title = rawTitle.replace(/_/g, ' ').trim() || 'untitled';
  cursor += 1;

  let band: LayerBand = 'normal';
  let zIndex = 0;
  let step = 0;
  let transition: TransitionType = 'fade';
  let group: string | null = null;
  let isDefault = false;
  const languages: string[] = [];
  const shortcuts: ParsedShortcut[] = [];

  for (let i = cursor; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok === 'underlay' || tok.startsWith('underlay_')) {
      band = 'underlay';
      let z = 0;
      if (tok.startsWith('underlay_')) {
        const parsedZ = Number.parseInt(tok.slice('underlay_'.length), 10);
        if (!Number.isNaN(parsedZ)) z = parsedZ;
      } else if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
        z = Number.parseInt(tokens[i + 1], 10);
        i += 1;
      }
      zIndex = -1000 + z;
    } else if (tok === 'overlay' || tok.startsWith('overlay_')) {
      band = 'overlay';
      let z = 0;
      if (tok.startsWith('overlay_')) {
        const parsedZ = Number.parseInt(tok.slice('overlay_'.length), 10);
        if (!Number.isNaN(parsedZ)) z = parsedZ;
      } else if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
        z = Number.parseInt(tokens[i + 1], 10);
        i += 1;
      }
      zIndex = 1000 + z;
    } else if (tok.startsWith('step_')) {
      const k = Number.parseInt(tok.slice('step_'.length), 10);
      if (!Number.isNaN(k) && k >= 0) {
        step = k;
      }
    } else if (tok.startsWith('t_')) {
      const t = tok.slice('t_'.length).toLowerCase();
      if (VALID_TRANSITIONS.has(t)) {
        transition = t as TransitionType;
      }
    } else if (tok.startsWith('g_')) {
      const g = tok.slice('g_'.length).trim();
      if (g) group = g;
    } else if (tok === 'default') {
      isDefault = true;
    } else if (tok.startsWith('lang_')) {
      const codes = tok
        .slice('lang_'.length)
        .split('_')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      for (const c of codes) {
        if (!languages.includes(c)) {
          languages.push(c);
        }
      }
    } else if (tok.startsWith('s_')) {
      const sc = parseShortcutToken(tok);
      if (sc) shortcuts.push(sc);
    }
  }

  return {
    filename,
    selector,
    title,
    rawTitle,
    band,
    zIndex,
    step,
    transition,
    group,
    isDefault,
    languages,
    shortcuts,
  };
}

export function parseSidecarFilename(filepath: string): ParsedSidecarMeta | null {
  const filename = basenameOf(filepath);
  const lower = filename.toLowerCase();
  let ext: 'md' | 'txt' | null = null;
  if (lower.endsWith('.md')) ext = 'md';
  else if (lower.endsWith('.txt')) ext = 'txt';
  if (!ext) return null;

  const stem = filename.slice(0, -(ext.length + 1));
  if (!stem) return null;

  const tokens = stem.split('-');
  let selector: ParsedSelector;
  let rawTitle: string;

  if (SELECTOR_REGEX.test(tokens[0])) {
    selector = parseSelector(tokens[0]);
    rawTitle = tokens[1] ?? '';
  } else {
    selector = createGlobalSelector();
    rawTitle = tokens[0] ?? '';
  }

  const title = rawTitle.replace(/_/g, ' ').trim();

  return {
    filename,
    selector,
    title,
    rawTitle,
    ext,
  };
}

export function computeTotalSlides(layers: ParsedLayerMeta[]): number {
  if (layers.length === 0) return 0;
  let maxSlide = 0;
  for (const layer of layers) {
    for (const r of layer.selector.ranges) {
      if (!r.negate && r.end > maxSlide) {
        maxSlide = r.end;
      }
    }
  }
  return Math.max(1, maxSlide);
}

export function isLayerDefaultActive(meta: ParsedLayerMeta): boolean {
  if (meta.isDefault) return true;
  if (meta.shortcuts.length > 0) return false;
  if (meta.group !== null) return false;
  return true;
}
