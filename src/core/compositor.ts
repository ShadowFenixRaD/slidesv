import { computeTotalSlides, matchesSlide } from './parser.ts';
import type {
  ComposedLayer,
  ComposedSlide,
  DeckData,
  FilterGroupInfo,
  LayerBand,
  LayerInput,
  SidecarInput,
  ToggleFilterInfo,
  TransitionType,
} from './types.ts';

export interface PlaceholderContext {
  index: number;
  total: number;
  title: string;
  progress: number;
  date: string;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function resolvePlaceholders(markup: string, ctx: PlaceholderContext): string {
  return markup
    .replace(/\{\{INDEX\}\}/g, String(ctx.index))
    .replace(/\{\{TOTAL\}\}/g, String(ctx.total))
    .replace(/\{\{TITLE\}\}/g, escapeXmlText(ctx.title))
    .replace(/\{\{PROGRESS\}\}/g, String(ctx.progress))
    .replace(/\{\{DATE\}\}/g, escapeXmlText(ctx.date));
}

export function extractSvgDesc(svgMarkup: string): string[] {
  const results: string[] = [];
  const descRegex = /<desc\b[^>]*>([\s\S]*?)<\/desc>/gi;
  let match: RegExpExecArray | null;
  while ((match = descRegex.exec(svgMarkup)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim();
    if (text) results.push(text);
  }
  return results;
}

export function extractSystemLanguages(svgMarkup: string): string[] {
  const langs: string[] = [];
  const attrRegex = /\bsystemLanguage\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(svgMarkup)) !== null) {
    const raw = match[1] ?? match[2] ?? '';
    for (const part of raw.split(',')) {
      const code = part.trim().toLowerCase();
      if (code && !langs.includes(code)) {
        langs.push(code);
      }
    }
  }
  return langs;
}

function rewriteSmilTimingList(value: string, prefix: string, knownIds: Set<string>): string {
  return value
    .split(';')
    .map((item) => {
      const trimmed = item.trim();
      if (!trimmed) return item;
      return trimmed.replace(
        /\b([A-Za-z_][A-Za-z0-9_:-]*)\.([A-Za-z_][A-Za-z0-9_()-]*)/g,
        (full, idPart: string, eventPart: string) => {
          if (knownIds.has(idPart)) {
            return `${prefix}${idPart}.${eventPart}`;
          }
          return full;
        },
      );
    })
    .join(';');
}

export function sanitizeAndNamespaceSvg(
  rawSvg: string,
  prefix: string,
  band: LayerBand,
): string {
  let svg = rawSvg
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>\s*/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>\s*/gi, '')
    .trim();

  // Sanitize root <svg ...> attributes
  svg = svg.replace(/<svg\b([^>]*)>/i, (_full, attrs: string) => {
    let cleaned = attrs;

    const hasViewBox = /\bviewBox\s*=/i.test(cleaned);
    if (!hasViewBox) {
      const wMatch = cleaned.match(/\bwidth\s*=\s*(?:"([0-9.]+)(?:px)?"|'([0-9.]+)(?:px)?')/i);
      const hMatch = cleaned.match(/\bheight\s*=\s*(?:"([0-9.]+)(?:px)?"|'([0-9.]+)(?:px)?')/i);
      const w = wMatch?.[1] ?? wMatch?.[2];
      const h = hMatch?.[1] ?? hMatch?.[2];
      if (w && h) {
        cleaned += ` viewBox="0 0 ${w} ${h}"`;
      }
    }

    cleaned = cleaned
      .replace(/\s+\bwidth\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
      .replace(/\s+\bheight\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');

    if (band === 'underlay' || band === 'overlay') {
      if (/\bstyle\s*=\s*"([^"]*)"/i.test(cleaned)) {
        cleaned = cleaned.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_s, styleVal: string) => {
          const filtered = styleVal
            .split(';')
            .map((p) => p.trim())
            .filter((p) => p && !/^background(-color)?\s*:/i.test(p));
          filtered.push('background: transparent');
          return `style="${filtered.join('; ')}"`;
        });
      } else {
        cleaned += ' style="background: transparent"';
      }
    }

    return `<svg${cleaned}>`;
  });

  // Convert systemLanguage to data-system-language so JS controls <switch> visibility
  svg = svg.replace(
    /\bsystemLanguage\s*=\s*("[^"]*"|'[^']*')/gi,
    'data-system-language=$1',
  );

  // Collect all IDs in this SVG
  const knownIds = new Set<string>();
  const idRegex = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  let idMatch: RegExpExecArray | null;
  while ((idMatch = idRegex.exec(svg)) !== null) {
    const idVal = idMatch[1] ?? idMatch[2];
    if (idVal) knownIds.add(idVal);
  }

  if (knownIds.size > 0) {
    // Namespace id="..."
    svg = svg.replace(/\bid\s*=\s*("([^"]+)"|'([^']+)')/g, (_m, _q, dVal: string, sVal: string) => {
      const val = dVal ?? sVal;
      return `id="${prefix}${val}"`;
    });

    // Namespace url(#...)
    svg = svg.replace(/url\(\s*#([^)\s'"]+)\s*\)/g, (_m, refId: string) => {
      return knownIds.has(refId) ? `url(#${prefix}${refId})` : `url(#${refId})`;
    });

    // Namespace href="#..." and xlink:href="#..."
    svg = svg.replace(
      /\b((?:xlink:)?href)\s*=\s*(?:"(#[^"]*)"|'(#[^']*)')/gi,
      (full, attrName: string, dHref: string, sHref: string) => {
        const href = dHref ?? sHref;
        const refId = href.slice(1);
        if (knownIds.has(refId)) {
          return `${attrName}="#${prefix}${refId}"`;
        }
        return full;
      },
    );

    // Namespace SMIL begin="..." and end="..."
    svg = svg.replace(
      /\b(begin|end)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
      (_full, attrName: string, dVal: string, sVal: string) => {
        const val = dVal ?? sVal ?? '';
        const rewritten = rewriteSmilTimingList(val, prefix, knownIds);
        return `${attrName}="${rewritten}"`;
      },
    );
  }

  return svg;
}

export function composeDeck(
  layerInputs: LayerInput[],
  sidecarInputs: SidecarInput[] = [],
  buildDate?: string,
): DeckData {
  const dateStr = buildDate ?? new Date().toISOString().slice(0, 10);
  const totalSlides = computeTotalSlides(layerInputs.map((l) => l.meta));

  const languages: string[] = [];
  const addLang = (code: string) => {
    const norm = code.trim().toLowerCase();
    if (norm && !languages.includes(norm)) {
      languages.push(norm);
    }
  };

  const groupMap = new Map<string, FilterGroupInfo>();
  const toggles: ToggleFilterInfo[] = [];
  const seenToggleKeys = new Set<string>();

  for (const input of layerInputs) {
    const { meta, svgContent } = input;
    for (const l of meta.languages) addLang(l);
    for (const l of extractSystemLanguages(svgContent)) addLang(l);

    if (meta.group) {
      let groupInfo = groupMap.get(meta.group);
      if (!groupInfo) {
        groupInfo = { name: meta.group, options: [] };
        groupMap.set(meta.group, groupInfo);
      }
      if (!groupInfo.options.some((o) => o.layerKey === meta.filename)) {
        groupInfo.options.push({
          layerKey: meta.filename,
          title: meta.title,
          isDefault: meta.isDefault,
          shortcuts: meta.shortcuts,
        });
      }
    } else if (meta.shortcuts.length > 0 && !seenToggleKeys.has(meta.filename)) {
      seenToggleKeys.add(meta.filename);
      toggles.push({
        layerKey: meta.filename,
        title: meta.title,
        isDefault: meta.isDefault,
        shortcuts: meta.shortcuts,
      });
    }
  }

  // Ensure each radio group has a default if none was explicitly marked
  for (const group of groupMap.values()) {
    if (group.options.length > 0 && !group.options.some((o) => o.isDefault)) {
      group.options[0].isDefault = true;
    }
  }

  const slides: ComposedSlide[] = [];

  for (let slideIndex = 1; slideIndex <= totalSlides; slideIndex += 1) {
    const matching = layerInputs
      .map((input, idx) => ({ input, idx }))
      .filter(({ input }) => matchesSlide(input.meta.selector, slideIndex));

    matching.sort((a, b) => {
      if (a.input.meta.zIndex !== b.input.meta.zIndex) {
        return a.input.meta.zIndex - b.input.meta.zIndex;
      }
      if (a.input.meta.step !== b.input.meta.step) {
        return a.input.meta.step - b.input.meta.step;
      }
      return a.idx - b.idx;
    });

    const primaryNormal = matching.find((m) => m.input.meta.band === 'normal');
    const slideTitle =
      primaryNormal?.input.meta.title ??
      matching[0]?.input.meta.title ??
      `Slide ${slideIndex}`;

    const transition: TransitionType =
      primaryNormal?.input.meta.transition ??
      matching[0]?.input.meta.transition ??
      'fade';

    const progress =
      totalSlides > 0 ? Math.round((slideIndex / totalSlides) * 100) : 0;

    const ctx: PlaceholderContext = {
      index: slideIndex,
      total: totalSlides,
      title: slideTitle,
      progress,
      date: dateStr,
    };

    let maxStep = 0;
    const composedLayers: ComposedLayer[] = [];
    const noteParts: string[] = [];

    matching.forEach(({ input }, layerOrder) => {
      if (input.meta.step > maxStep) {
        maxStep = input.meta.step;
      }
      const prefix = `s${slideIndex}_l${layerOrder}_`;
      const sanitized = sanitizeAndNamespaceSvg(
        input.svgContent,
        prefix,
        input.meta.band,
      );
      const resolved = resolvePlaceholders(sanitized, ctx);

      if (input.meta.band === 'normal') {
        for (const desc of extractSvgDesc(input.svgContent)) {
          if (!noteParts.includes(desc)) {
            noteParts.push(desc);
          }
        }
      }

      composedLayers.push({
        id: `${prefix}root`,
        meta: input.meta,
        svgMarkup: resolved,
        order: layerOrder,
      });
    });

    const matchingSidecars = sidecarInputs.filter((sc) =>
      matchesSlide(sc.meta.selector, slideIndex),
    );
    for (const sc of matchingSidecars) {
      const trimmed = sc.content.trim();
      if (trimmed) {
        noteParts.unshift(trimmed);
      }
    }

    slides.push({
      index: slideIndex,
      title: slideTitle,
      transition,
      maxStep,
      layers: composedLayers,
      notes: noteParts.join('\n\n'),
    });
  }

  return {
    totalSlides,
    slides,
    languages,
    groups: Array.from(groupMap.values()),
    toggles,
    buildDate: dateStr,
  };
}
