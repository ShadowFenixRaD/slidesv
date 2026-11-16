import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildLiveIndexHtml, compileBrowserBundle } from '../src/build/bundler.ts';
import { extractFontFamilies } from '../src/build/fonts.ts';
import { composeDeck, resolvePlaceholders, sanitizeAndNamespaceSvg } from '../src/core/compositor.ts';
import {
  computeTotalSlides,
  matchesSlide,
  parseSidecarFilename,
  parseSvgFilename,
} from '../src/core/parser.ts';

test('parser: selectors, ranges, negations, and global', () => {
  const s1 = parseSvgFilename('1-intro.svg')!;
  assert.equal(s1.title, 'intro');
  assert.equal(matchesSlide(s1.selector, 1), true);
  assert.equal(matchesSlide(s1.selector, 2), false);

  const sRange = parseSvgFilename('1_5,!3-chapter_one.svg')!;
  assert.equal(sRange.title, 'chapter one');
  assert.equal(matchesSlide(sRange.selector, 1), true);
  assert.equal(matchesSlide(sRange.selector, 3), false);
  assert.equal(matchesSlide(sRange.selector, 5), true);
  assert.equal(matchesSlide(sRange.selector, 6), false);

  const sNegOnly = parseSvgFilename('!1,!10-footer-overlay_2.svg')!;
  assert.equal(sNegOnly.band, 'overlay');
  assert.equal(sNegOnly.zIndex, 1002);
  assert.equal(matchesSlide(sNegOnly.selector, 1), false);
  assert.equal(matchesSlide(sNegOnly.selector, 2), true);
  assert.equal(matchesSlide(sNegOnly.selector, 10), false);
  assert.equal(matchesSlide(sNegOnly.selector, 11), true);

  const sDisjoint = parseSvgFilename('1,3,5_7-diagram.svg')!;
  assert.equal(matchesSlide(sDisjoint.selector, 1), true);
  assert.equal(matchesSlide(sDisjoint.selector, 2), false);
  assert.equal(matchesSlide(sDisjoint.selector, 6), true);

  const sGlobal = parseSvgFilename('background-underlay_0.svg')!;
  assert.equal(sGlobal.selector.isGlobal, true);
  assert.equal(sGlobal.band, 'underlay');
  assert.equal(sGlobal.zIndex, -1000);
  assert.equal(matchesSlide(sGlobal.selector, 99), true);
});

test('parser: options, steps, transitions, groups, languages, and multiple shortcuts', () => {
  const meta = parseSvgFilename(
    '2_4-system_architecture-overlay_3-step_2-t_zoom-g_theme-default-lang_it_en-s_ctrl_win_z-s_alt_k.svg',
  )!;

  assert.equal(meta.title, 'system architecture');
  assert.equal(meta.band, 'overlay');
  assert.equal(meta.zIndex, 1003);
  assert.equal(meta.step, 2);
  assert.equal(meta.transition, 'zoom');
  assert.equal(meta.group, 'theme');
  assert.equal(meta.isDefault, true);
  assert.deepEqual(meta.languages, ['it', 'en']);
  assert.equal(meta.shortcuts.length, 2);
  assert.equal(meta.shortcuts[0].signature, 'ctrl+meta+z');
  assert.equal(meta.shortcuts[0].display, 'ctrl+win+z');
  assert.equal(meta.shortcuts[1].signature, 'alt+k');

  assert.equal(computeTotalSlides([meta]), 4);
});

test('parser: sidecar markdown and text files', () => {
  const md = parseSidecarFilename('2-architecture.md')!;
  assert.equal(md.ext, 'md');
  assert.equal(md.title, 'architecture');
  assert.equal(matchesSlide(md.selector, 2), true);
  assert.equal(matchesSlide(md.selector, 3), false);
});

test('compositor: sanitization, ID & SMIL namespacing, <switch>, and placeholders', () => {
  const rawSvg = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" style="background: #fff; color: red">
  <defs>
    <linearGradient id="grad1"><stop offset="0%" stop-color="#000"/></linearGradient>
  </defs>
  <rect fill="url(#grad1)" width="1280" height="720">
    <animate id="fade1" attributeName="opacity" from="0" to="1" dur="1s" begin="0s" />
    <animate attributeName="x" from="0" to="10" dur="1s" begin="fade1.end+0.2s" />
  </rect>
  <use href="#grad1" />
  <switch>
    <text systemLanguage="en">Hello {{TITLE}} ({{INDEX}}/{{TOTAL}})</text>
    <text systemLanguage="it">Ciao {{TITLE}} ({{PROGRESS}}%)</text>
    <text>Fallback {{DATE}}</text>
  </switch>
</svg>`;

  const sanitized = sanitizeAndNamespaceSvg(rawSvg, 's1_l0_', 'overlay');
  const rootOpenTag = sanitized.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  assert.ok(!sanitized.includes('<?xml'));
  assert.ok(!sanitized.includes('<!DOCTYPE'));
  assert.ok(rootOpenTag.includes('viewBox="0 0 1280 720"'));
  assert.ok(!/\swidth="1280"/.test(rootOpenTag));
  assert.ok(rootOpenTag.includes('background: transparent'));
  assert.ok(sanitized.includes('id="s1_l0_grad1"'));
  assert.ok(sanitized.includes('url(#s1_l0_grad1)'));
  assert.ok(sanitized.includes('href="#s1_l0_grad1"'));
  assert.ok(sanitized.includes('begin="s1_l0_fade1.end+0.2s"'));
  assert.ok(sanitized.includes('data-system-language="en"'));

  const resolved = resolvePlaceholders(sanitized, {
    index: 2,
    total: 5,
    title: 'A & B',
    progress: 40,
    date: '2026-11-16',
  });
  assert.ok(resolved.includes('Hello A &amp; B (2/5)'));
  assert.ok(resolved.includes('Ciao A &amp; B (40%)'));
  assert.ok(resolved.includes('Fallback 2026-11-16'));
});

test('compositor: composeDeck detects languages, groups, toggles, and notes', () => {
  const m1 = parseSvgFilename('1-intro.svg')!;
  const m2 = parseSvgFilename('2-arch-step_1-g_theme-default.svg')!;
  const m3 = parseSvgFilename('2-arch_alt-g_theme.svg')!;
  const m4 = parseSvgFilename('grid-overlay-s_ctrl_alt_z.svg')!;
  const sc = parseSidecarFilename('2-arch.md')!;

  const deck = composeDeck(
    [
      {
        meta: m1,
        svgContent: '<svg viewBox="0 0 100 100"><desc>Slide 1 note</desc><switch><text systemLanguage="fr">Bonjour</text></switch></svg>',
      },
      { meta: m2, svgContent: '<svg viewBox="0 0 100 100"></svg>' },
      { meta: m3, svgContent: '<svg viewBox="0 0 100 100"></svg>' },
      { meta: m4, svgContent: '<svg viewBox="0 0 100 100"></svg>' },
    ],
    [{ meta: sc, content: 'Markdown note' }],
    '2026-11-16',
  );

  assert.equal(deck.totalSlides, 2);
  assert.deepEqual(deck.languages, ['fr']);
  assert.equal(deck.groups.length, 1);
  assert.equal(deck.groups[0].name, 'theme');
  assert.equal(deck.toggles.length, 1);
  assert.equal(deck.slides[0].notes, 'Slide 1 note');
  assert.equal(deck.slides[1].notes, 'Markdown note');
  assert.equal(deck.slides[1].maxStep, 1);
});

test('fonts: extractFontFamilies ignores generic families', () => {
  const fams = extractFontFamilies([
    '<svg><text font-family="Inter, sans-serif">Hi</text><style>.a { font-family: "Fira Code", monospace; }</style></svg>',
  ]);
  assert.deepEqual(fams, ['Inter', 'Fira Code']);
});

test('bundler: compiled browser bundle is syntactically valid JS', () => {
  const { js, css } = compileBrowserBundle();
  assert.ok(css.includes('.stage-wrapper'));
  // Validate JS syntax using Node VM compiler
  new vm.Script(js, { filename: 'slidesv-bundle.js' });

  const liveHtml = buildLiveIndexHtml();
  assert.ok(liveHtml.includes('<!DOCTYPE html>'));
  assert.ok(liveHtml.includes('<script>'));
});

test('cli: build demo-deck produces standalone dist/presentation.html', () => {
  const root = resolve('.');
  const outPath = join(root, 'demo-deck', 'dist', 'presentation.html');
  if (existsSync(outPath)) rmSync(outPath);

  execFileSync('node', ['cli.ts', 'build', 'demo-deck', '--out', outPath], {
    cwd: root,
    stdio: 'pipe',
  });

  assert.ok(existsSync(outPath));
  const html = readFileSync(outPath, 'utf8');
  assert.ok(html.includes('window.__SLIDESV_DECK__'));
  assert.ok(html.includes('"totalSlides":3'));
  assert.ok(html.includes('data-system-language=\\"it\\"'));
  assert.ok(html.includes('"maxStep":2'));

  execFileSync(
    'node',
    ['cli.ts', 'build', 'demo-deck', '--skip-starter', '--out', outPath],
    { cwd: root, stdio: 'pipe' },
  );
  const skipHtml = readFileSync(outPath, 'utf8');
  assert.ok(skipHtml.includes('"skipStarter":true'));
});
