import type { DeckData } from '../core/types.ts';
import {
  applySwitchLanguage,
  eventMatchesShortcut,
  getAvailableStepsForSlide,
  isLayerEligibleForState,
  SyncBus,
} from './tools.ts';
import type { SyncStatePayload } from './tools.ts';

function renderSlidePreviewInto(
  container: HTMLElement,
  deck: DeckData,
  slideNum: number,
  stepNum: number,
  state: SyncStatePayload,
): void {
  container.innerHTML = '';
  if (slideNum < 1 || slideNum > deck.totalSlides) {
    const empty = document.createElement('div');
    empty.style.color = '#9aa5b8';
    empty.style.fontSize = '0.95rem';
    empty.textContent =
      slideNum === 0 ? 'Slide 0: Program Starter' : 'End of Presentation';
    container.appendChild(empty);
    return;
  }

  const slide = deck.slides[slideNum - 1];
  if (!slide) return;

  const grid = document.createElement('div');
  grid.className = 'slide-layers-grid';

  for (const layer of slide.layers) {
    if (layer.meta.step > stepNum) continue;
    if (!isLayerEligibleForState(layer, state)) continue;

    const slot = document.createElement('div');
    slot.className = 'layer-slot';
    slot.innerHTML = layer.svgMarkup;
    applySwitchLanguage(slot, state.activeLanguage);

    // Ensure SMIL entrance animations in preview settle visibly
    slot.querySelectorAll('svg').forEach((svg) => {
      try {
        if (typeof svg.setCurrentTime === 'function') {
          svg.setCurrentTime(60);
        }
        if (typeof svg.pauseAnimations === 'function') {
          svg.pauseAnimations();
        }
      } catch {
        // ignore if unsupported
      }
    });

    grid.appendChild(slot);
  }

  container.appendChild(grid);
}

export function mountPresenterView(
  deck: DeckData,
  initialState: SyncStatePayload,
  bus: SyncBus,
): void {
  document.title = 'Presenter View — Slidesv';
  let state: SyncStatePayload = {
    ...initialState,
    groupChoices: { ...initialState.groupChoices },
    toggles: { ...initialState.toggles },
  };

  let elapsedSeconds = 0;
  let timerRunning = true;

  document.body.innerHTML = `
    <div class="presenter-layout">
      <div class="presenter-topbar">
        <div>
          <strong id="p-slide-title">Slide ${state.currentSlide} / ${deck.totalSlides}</strong>
        </div>
        <div class="presenter-timers">
          <span id="p-elapsed">00:00:00</span>
          <button class="btn btn-sm" id="p-timer-toggle">Pause</button>
          <button class="btn btn-sm" id="p-timer-reset">Reset</button>
          <span style="color: var(--muted)">|</span>
          <span id="p-clock">--:--:--</span>
        </div>
      </div>

      <div class="presenter-main-preview" id="p-current-preview"></div>

      <div class="presenter-side">
        <div class="presenter-next-box">
          <div class="box-label" id="p-next-label">Next</div>
          <div class="presenter-next-preview" id="p-next-preview"></div>
        </div>
        <div class="presenter-notes-box">
          <div class="box-label" style="margin-bottom: 0.5rem;">Speaker Notes</div>
          <div class="presenter-notes-content" id="p-notes"></div>
        </div>
      </div>

      <div class="presenter-footer">
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <button class="btn btn-sm" id="p-home" title="Slide 0">⌂</button>
          <button class="btn btn-sm" id="p-prev">← Previous</button>
          <button class="btn btn-sm btn-primary" id="p-next">Next →</button>
        </div>
        <div class="presenter-controls-strip" id="p-controls-strip"></div>
        <div style="color: var(--muted); font-size: 0.78rem;">
          Synced via BroadcastChannel • <kbd>←</kbd> <kbd>→</kbd> <kbd>Space</kbd>
        </div>
      </div>
    </div>
  `;

  const titleEl = document.getElementById('p-slide-title')!;
  const currentEl = document.getElementById('p-current-preview')!;
  const nextLabelEl = document.getElementById('p-next-label')!;
  const nextEl = document.getElementById('p-next-preview')!;
  const notesEl = document.getElementById('p-notes')!;
  const controlsEl = document.getElementById('p-controls-strip')!;
  const elapsedEl = document.getElementById('p-elapsed')!;
  const clockEl = document.getElementById('p-clock')!;
  const timerToggleBtn = document.getElementById('p-timer-toggle')!;
  const timerResetBtn = document.getElementById('p-timer-reset')!;

  const formatDuration = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  };

  const updateClocks = () => {
    elapsedEl.textContent = formatDuration(elapsedSeconds);
    clockEl.textContent = new Date().toLocaleTimeString();
  };

  updateClocks();
  setInterval(() => {
    if (timerRunning) elapsedSeconds += 1;
    updateClocks();
  }, 1000);

  timerToggleBtn.addEventListener('click', () => {
    timerRunning = !timerRunning;
    timerToggleBtn.textContent = timerRunning ? 'Pause' : 'Resume';
  });

  timerResetBtn.addEventListener('click', () => {
    elapsedSeconds = 0;
    updateClocks();
  });

  const renderControls = () => {
    const parts: string[] = [];

    if (deck.languages.length > 0) {
      parts.push(`
        <div class="presenter-ctrl-group">
          <span class="presenter-ctrl-label">Lang</span>
          ${deck.languages
            .map(
              (l) =>
                `<button class="btn btn-sm btn-pill ${l === state.activeLanguage ? 'is-active' : ''}" data-p-lang="${l}">${l.toUpperCase()}</button>`,
            )
            .join('')}
        </div>
      `);
    }

    for (const g of deck.groups) {
      parts.push(`
        <div class="presenter-ctrl-group">
          <span class="presenter-ctrl-label">${g.name}</span>
          ${g.options
            .map((opt) => {
              const active = state.groupChoices[g.name] === opt.layerKey;
              const kbd = opt.shortcuts.map((s) => `<kbd>${s.display}</kbd>`).join(' ');
              return `<button class="btn btn-sm btn-pill ${active ? 'is-active' : ''}" data-p-group="${g.name}" data-p-key="${opt.layerKey}">${opt.title} ${kbd}</button>`;
            })
            .join('')}
        </div>
      `);
    }

    if (deck.toggles.length > 0) {
      parts.push(`
        <div class="presenter-ctrl-group">
          <span class="presenter-ctrl-label">Toggles</span>
          ${deck.toggles
            .map((t) => {
              const active = Boolean(state.toggles[t.layerKey]);
              const kbd = t.shortcuts.map((s) => `<kbd>${s.display}</kbd>`).join(' ');
              return `<button class="btn btn-sm ${active ? 'is-active' : ''}" data-p-toggle="${t.layerKey}">${t.title} ${kbd}</button>`;
            })
            .join('')}
        </div>
      `);
    }

    controlsEl.innerHTML = parts.join('');

    controlsEl.querySelectorAll<HTMLElement>('[data-p-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.pLang ?? '';
        state.activeLanguage = lang;
        render();
        bus.send({ type: 'set-language', lang });
      });
    });

    controlsEl.querySelectorAll<HTMLElement>('[data-p-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.pGroup ?? '';
        const layerKey = btn.dataset.pKey ?? '';
        state.groupChoices[group] = layerKey;
        render();
        bus.send({ type: 'set-group', group, layerKey });
      });
    });

    controlsEl.querySelectorAll<HTMLElement>('[data-p-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const layerKey = btn.dataset.pToggle ?? '';
        state.toggles[layerKey] = !state.toggles[layerKey];
        render();
        bus.send({ type: 'toggle-filter', layerKey });
      });
    });
  };

  const render = () => {
    const slide =
      state.currentSlide >= 1 ? deck.slides[state.currentSlide - 1] : null;
    const steps = slide ? getAvailableStepsForSlide(slide, state) : [0];
    const maxStep = steps[steps.length - 1] ?? 0;
    const currentStepIdx = steps.indexOf(state.currentStep);

    titleEl.textContent =
      state.currentSlide === 0
        ? `Slide 0 (Starter) — ${deck.totalSlides} slides`
        : `Slide ${state.currentSlide} / ${deck.totalSlides} — ${slide?.title ?? ''} (Step ${state.currentStep}/${maxStep})`;

    renderSlidePreviewInto(
      currentEl,
      deck,
      state.currentSlide,
      state.currentStep,
      state,
    );

    let nextSlide = state.currentSlide;
    let nextStep = state.currentStep;
    if (state.currentSlide === 0) {
      nextSlide = deck.totalSlides > 0 ? 1 : 0;
      nextStep = 0;
    } else if (slide && currentStepIdx >= 0 && currentStepIdx < steps.length - 1) {
      nextStep = steps[currentStepIdx + 1];
    } else if (slide && state.currentStep < maxStep) {
      const nextAvailable = steps.find((s) => s > state.currentStep);
      if (nextAvailable !== undefined) {
        nextStep = nextAvailable;
      } else {
        nextSlide = state.currentSlide + 1;
        nextStep = 0;
      }
    } else {
      nextSlide = state.currentSlide + 1;
      nextStep = 0;
    }

    nextLabelEl.textContent =
      nextSlide > deck.totalSlides
        ? 'Next: End of Presentation'
        : `Next: Slide ${nextSlide}${nextStep > 0 ? ` (Step ${nextStep})` : ''}`;
    renderSlidePreviewInto(nextEl, deck, nextSlide, nextStep, state);

    notesEl.textContent =
      slide?.notes || 'No speaker notes for this slide.';

    renderControls();
  };

  bus.onMessage((msg) => {
    if (msg.type === 'state') {
      state = {
        ...msg.payload,
        groupChoices: { ...msg.payload.groupChoices },
        toggles: { ...msg.payload.toggles },
      };
      render();
    }
  });

  document.getElementById('p-home')!.addEventListener('click', () => {
    bus.send({ type: 'nav', action: 'goto', slide: 0, step: 0 });
  });
  document.getElementById('p-prev')!.addEventListener('click', () => {
    bus.send({ type: 'nav', action: 'prev' });
  });
  document.getElementById('p-next')!.addEventListener('click', () => {
    bus.send({ type: 'nav', action: 'next' });
  });

  window.addEventListener('keydown', (e) => {
    for (const g of deck.groups) {
      for (const opt of g.options) {
        if (opt.shortcuts.some((sc) => eventMatchesShortcut(e, sc))) {
          e.preventDefault();
          state.groupChoices[g.name] = opt.layerKey;
          render();
          bus.send({ type: 'set-group', group: g.name, layerKey: opt.layerKey });
          return;
        }
      }
    }
    for (const t of deck.toggles) {
      if (t.shortcuts.some((sc) => eventMatchesShortcut(e, sc))) {
        e.preventDefault();
        state.toggles[t.layerKey] = !state.toggles[t.layerKey];
        render();
        bus.send({ type: 'toggle-filter', layerKey: t.layerKey });
        return;
      }
    }

    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      bus.send({ type: 'nav', action: 'next' });
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      bus.send({ type: 'nav', action: 'prev' });
    } else if (e.key === 'Home' || e.key === '0') {
      e.preventDefault();
      bus.send({ type: 'nav', action: 'goto', slide: 0, step: 0 });
    }
  });

  render();
  bus.send({ type: 'request-state' });
}
