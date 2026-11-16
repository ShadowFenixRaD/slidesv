import type { ComposedLayer, DeckData } from '../core/types.ts';
import { applySwitchLanguage, SyncBus } from './tools.ts';
import type { SyncStatePayload } from './tools.ts';

function isLayerVisibleForState(
  layer: ComposedLayer,
  state: SyncStatePayload,
): boolean {
  const { meta } = layer;
  if (meta.step > state.currentStep) return false;
  if (
    meta.languages.length > 0 &&
    state.activeLanguage &&
    !meta.languages.includes(state.activeLanguage.toLowerCase())
  ) {
    return false;
  }
  if (meta.group !== null) {
    return state.groupChoices[meta.group] === meta.filename;
  }
  if (meta.shortcuts.length > 0) {
    return Boolean(state.toggles[meta.filename]);
  }
  return true;
}

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
  const previewState: SyncStatePayload = { ...state, currentStep: stepNum };

  for (const layer of slide.layers) {
    if (!isLayerVisibleForState(layer, previewState)) continue;
    const slot = document.createElement('div');
    slot.className = 'layer-slot';
    slot.innerHTML = layer.svgMarkup;
    applySwitchLanguage(slot, state.activeLanguage);
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
  let state: SyncStatePayload = { ...initialState };

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
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-sm" id="p-prev">← Previous</button>
          <button class="btn btn-sm btn-primary" id="p-next">Next →</button>
        </div>
        <div style="color: var(--muted); font-size: 0.82rem;">
          Synced via BroadcastChannel • Press <kbd>←</kbd> <kbd>→</kbd> or <kbd>Space</kbd>
        </div>
      </div>
    </div>
  `;

  const titleEl = document.getElementById('p-slide-title')!;
  const currentEl = document.getElementById('p-current-preview')!;
  const nextLabelEl = document.getElementById('p-next-label')!;
  const nextEl = document.getElementById('p-next-preview')!;
  const notesEl = document.getElementById('p-notes')!;
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

  const render = () => {
    const slide =
      state.currentSlide >= 1 ? deck.slides[state.currentSlide - 1] : null;
    titleEl.textContent =
      state.currentSlide === 0
        ? `Slide 0 (Starter) — ${deck.totalSlides} slides`
        : `Slide ${state.currentSlide} / ${deck.totalSlides} — ${slide?.title ?? ''} (Step ${state.currentStep}/${slide?.maxStep ?? 0})`;

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
      nextSlide = 1;
      nextStep = 0;
    } else if (slide && state.currentStep < slide.maxStep) {
      nextStep = state.currentStep + 1;
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
  };

  bus.onMessage((msg) => {
    if (msg.type === 'state') {
      state = msg.payload;
      render();
    }
  });

  document.getElementById('p-prev')!.addEventListener('click', () => {
    bus.send({ type: 'nav', action: 'prev' });
  });
  document.getElementById('p-next')!.addEventListener('click', () => {
    bus.send({ type: 'nav', action: 'next' });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      bus.send({ type: 'nav', action: 'next' });
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      bus.send({ type: 'nav', action: 'prev' });
    }
  });

  render();
  bus.send({ type: 'request-state' });
}
