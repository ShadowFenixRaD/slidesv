import { isLayerDefaultActive } from '../core/parser.ts';
import type { ComposedLayer, DeckData } from '../core/types.ts';
import { mountPresenterView } from './presenter.ts';
import {
  applySwitchLanguage,
  DrawingController,
  eventMatchesShortcut,
  getAvailableStepsForSlide,
  LaserController,
  pauseSvgAnimations,
  resetAndPlaySvgAnimations,
  SyncBus,
} from './tools.ts';
import type { SyncStatePayload } from './tools.ts';

export class SlidePlayer {
  private deck: DeckData;
  private bus: SyncBus;
  private currentSlide = 0;
  private currentStep = 0;
  private activeLanguage = '';
  private groupChoices: Record<string, string> = {};
  private toggles: Record<string, boolean> = {};
  private hudVisible = true;
  private overviewOpen = false;

  private starterEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private slideContainer!: HTMLElement;
  private hudEl!: HTMLElement;
  private overviewEl!: HTMLElement;
  private drawCtrl!: DrawingController;
  private laserCtrl!: LaserController;

  private slideFrames: HTMLElement[] = [];

  constructor(
    deck: DeckData,
    initialLang?: string,
    initialFilters?: string[],
    skipStarterConfig?: boolean,
  ) {
    this.deck = deck;
    this.bus = new SyncBus();

    const params = new URLSearchParams(window.location.search);
    const urlLang = params.get('language')?.toLowerCase() ?? '';
    this.activeLanguage =
      urlLang ||
      (initialLang ? initialLang.toLowerCase() : '') ||
      (deck.languages[0] ?? '');

    this.initFilterDefaults(initialFilters);

    if (params.get('presenter') === '1') {
      mountPresenterView(deck, this.getSyncState(), this.bus);
      return;
    }

    const skipParam =
      params.get('skipStarter') ?? params.get('skip0') ?? params.get('start');
    const shouldSkipStarter =
      skipStarterConfig === true ||
      skipParam === '1' ||
      skipParam === 'true';

    const slideParam = params.get('slide');
    if (slideParam !== null) {
      const n = Number.parseInt(slideParam, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= deck.totalSlides) {
        this.currentSlide = n;
      }
    } else if (shouldSkipStarter && deck.totalSlides > 0) {
      this.currentSlide = 1;
    }

    const stepParam = params.get('step');
    if (stepParam !== null) {
      const s = Number.parseInt(stepParam, 10);
      if (!Number.isNaN(s) && s >= 0) {
        this.currentStep = s;
      }
    }

    this.mountStage();
    this.bindEvents();
    this.renderAll();
  }

  private initFilterDefaults(initialFilters?: string[]): void {
    const filterSet = new Set(
      (initialFilters ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean),
    );

    for (const g of this.deck.groups) {
      const matched = g.options.find(
        (o) =>
          filterSet.has(o.layerKey.toLowerCase()) ||
          filterSet.has(o.title.toLowerCase()),
      );
      const def = matched ?? g.options.find((o) => o.isDefault) ?? g.options[0];
      if (def) {
        this.groupChoices[g.name] = def.layerKey;
      }
    }

    for (const t of this.deck.toggles) {
      const forced =
        filterSet.has(t.layerKey.toLowerCase()) ||
        filterSet.has(t.title.toLowerCase());
      this.toggles[t.layerKey] = forced || t.isDefault;
    }
  }

  public updateDeck(newDeck: DeckData): void {
    this.deck = newDeck;

    // Preserve existing language if still valid or fallback
    if (!this.activeLanguage && newDeck.languages.length > 0) {
      this.activeLanguage = newDeck.languages[0];
    }

    // Ensure any newly added groups/toggles get defaults without overwriting user choices
    for (const g of newDeck.groups) {
      if (!this.groupChoices[g.name]) {
        const def = g.options.find((o) => o.isDefault) ?? g.options[0];
        if (def) this.groupChoices[g.name] = def.layerKey;
      }
    }
    for (const t of newDeck.toggles) {
      if (this.toggles[t.layerKey] === undefined) {
        this.toggles[t.layerKey] = t.isDefault;
      }
    }

    if (this.currentSlide > newDeck.totalSlides) {
      this.currentSlide = newDeck.totalSlides;
      this.currentStep = 0;
    }

    this.renderAll();
  }

  private getSyncState(): SyncStatePayload {
    return {
      currentSlide: this.currentSlide,
      currentStep: this.currentStep,
      activeLanguage: this.activeLanguage,
      groupChoices: { ...this.groupChoices },
      toggles: { ...this.toggles },
    };
  }

  private broadcastState(): void {
    this.bus.send({ type: 'state', payload: this.getSyncState() });
  }

  private mountStage(): void {
    document.body.innerHTML = `
      <div class="stage-wrapper" id="stage-wrapper">
        <div class="slide-container" id="slide-container"></div>
      </div>
      <div class="starter-view" id="starter-view"></div>
      <div class="hud-bar" id="hud-bar"></div>
      <div class="overview-modal hidden" id="overview-modal"></div>
      <canvas class="draw-canvas" id="draw-canvas"></canvas>
      <div class="laser-dot hidden" id="laser-dot"></div>
    `;

    this.stageEl = document.getElementById('stage-wrapper')!;
    this.slideContainer = document.getElementById('slide-container')!;
    this.starterEl = document.getElementById('starter-view')!;
    this.hudEl = document.getElementById('hud-bar')!;
    this.overviewEl = document.getElementById('overview-modal')!;

    this.drawCtrl = new DrawingController(
      document.getElementById('draw-canvas') as HTMLCanvasElement,
    );
    this.laserCtrl = new LaserController(
      document.getElementById('laser-dot')!,
      this.bus,
    );
  }

  private bindEvents(): void {
    this.bus.onMessage((msg) => {
      if (msg.type === 'request-state') {
        this.broadcastState();
      } else if (msg.type === 'nav') {
        if (msg.action === 'next') this.next();
        else if (msg.action === 'prev') this.prev();
        else if (msg.action === 'goto' && msg.slide !== undefined) {
          this.goToSlide(msg.slide, msg.step ?? 0);
        }
      } else if (msg.type === 'set-language') {
        this.setLanguage(msg.lang);
      } else if (msg.type === 'set-group') {
        this.selectGroupOption(msg.group, msg.layerKey);
      } else if (msg.type === 'toggle-filter') {
        this.toggleFilter(msg.layerKey);
      } else if (msg.type === 'laser') {
        if (msg.payload.active) {
          this.laserCtrl.showAt(msg.payload.x, msg.payload.y, false);
        } else {
          this.laserCtrl.hide(false);
        }
      }
    });

    this.stageEl.addEventListener('click', (e) => {
      if (this.currentSlide === 0 || this.overviewOpen || this.drawCtrl.isActive()) {
        return;
      }
      if ((e.target as HTMLElement).closest('#hud-bar')) return;
      this.next();
    });

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }

      // Check custom layer shortcuts (-s_...) first
      if (this.handleCustomShortcut(e)) {
        e.preventDefault();
        return;
      }

      const key = e.key;
      const lower = key.toLowerCase();

      if (lower === 'l') {
        this.laserCtrl.setHolding(true);
        return;
      }

      if (key === 'Escape') {
        e.preventDefault();
        this.toggleOverview();
        return;
      }

      if (lower === 'g') {
        e.preventDefault();
        this.toggleOverview();
        return;
      }

      if (lower === 'h') {
        e.preventDefault();
        this.hudVisible = !this.hudVisible;
        this.updateHudVisibility();
        return;
      }

      if (lower === 'd') {
        e.preventDefault();
        this.drawCtrl.toggle();
        this.renderHud();
        return;
      }

      if (lower === 'c') {
        e.preventDefault();
        this.drawCtrl.clear();
        return;
      }

      if (lower === 'p') {
        e.preventDefault();
        this.openPresenter();
        return;
      }

      if (lower === 'f') {
        e.preventDefault();
        this.toggleFullscreen();
        return;
      }

      if (key === 'Home' || key === '0') {
        e.preventDefault();
        this.goToSlide(0, 0);
        return;
      }

      if (key === 'ArrowRight' || key === ' ' || key === 'PageDown') {
        if (this.currentSlide === 0 && key === ' ') return;
        e.preventDefault();
        this.next();
      } else if (key === 'ArrowLeft' || key === 'PageUp') {
        e.preventDefault();
        this.prev();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'l') {
        this.laserCtrl.setHolding(false);
      }
    });
  }

  private handleCustomShortcut(e: KeyboardEvent): boolean {
    for (const g of this.deck.groups) {
      for (const opt of g.options) {
        if (opt.shortcuts.some((sc) => eventMatchesShortcut(e, sc))) {
          this.selectGroupOption(g.name, opt.layerKey);
          return true;
        }
      }
    }
    for (const t of this.deck.toggles) {
      if (t.shortcuts.some((sc) => eventMatchesShortcut(e, sc))) {
        this.toggleFilter(t.layerKey);
        return true;
      }
    }
    return false;
  }

  public setLanguage(lang: string): void {
    this.activeLanguage = lang.toLowerCase();
    const url = new URL(window.location.href);
    if (this.activeLanguage) {
      url.searchParams.set('language', this.activeLanguage);
    } else {
      url.searchParams.delete('language');
    }
    window.history.replaceState({}, '', url.toString());

    this.applyVisibilityAndAnimations(false);
    this.renderStarter();
    this.renderHud();
    if (this.overviewOpen) this.renderOverview();
    this.broadcastState();
  }

  public selectGroupOption(groupName: string, layerKey: string): void {
    this.groupChoices[groupName] = layerKey;
    this.applyVisibilityAndAnimations(false);
    this.renderStarter();
    this.renderHud();
    this.broadcastState();
  }

  public toggleFilter(layerKey: string): void {
    this.toggles[layerKey] = !this.toggles[layerKey];
    this.applyVisibilityAndAnimations(false);
    this.renderStarter();
    this.renderHud();
    this.broadcastState();
  }

  public next(): void {
    if (this.currentSlide === 0) {
      if (this.deck.totalSlides > 0) {
        this.goToSlide(1, 0);
      }
      return;
    }

    const slide = this.deck.slides[this.currentSlide - 1];
    if (slide) {
      const steps = getAvailableStepsForSlide(slide, this.getSyncState());
      const nextStep = steps.find((s) => s > this.currentStep);
      if (nextStep !== undefined) {
        this.currentStep = nextStep;
        this.applyVisibilityAndAnimations(true, this.currentStep);
        this.renderHud();
        this.broadcastState();
        return;
      }
    }

    if (this.currentSlide < this.deck.totalSlides) {
      this.goToSlide(this.currentSlide + 1, 0);
    }
  }

  public prev(): void {
    if (this.currentSlide === 0) return;

    const slide = this.deck.slides[this.currentSlide - 1];
    if (slide && this.currentStep > 0) {
      const steps = getAvailableStepsForSlide(slide, this.getSyncState());
      const prevSteps = steps.filter((s) => s < this.currentStep);
      this.currentStep = prevSteps[prevSteps.length - 1] ?? 0;
      this.applyVisibilityAndAnimations(false);
      this.renderHud();
      this.broadcastState();
      return;
    }

    if (this.currentSlide > 1) {
      const prevSlide = this.deck.slides[this.currentSlide - 2];
      const prevSteps = prevSlide
        ? getAvailableStepsForSlide(prevSlide, this.getSyncState())
        : [0];
      const maxPrevStep = prevSteps[prevSteps.length - 1] ?? 0;
      this.goToSlide(this.currentSlide - 1, maxPrevStep);
    } else {
      this.goToSlide(0, 0);
    }
  }

  public goToSlide(slideNum: number, stepNum = 0): void {
    const clamped = Math.max(0, Math.min(this.deck.totalSlides, slideNum));
    this.currentSlide = clamped;
    const slide = clamped >= 1 ? this.deck.slides[clamped - 1] : null;
    this.currentStep = slide ? Math.max(0, Math.min(slide.maxStep, stepNum)) : 0;

    if (this.overviewOpen) {
      this.overviewOpen = false;
      this.overviewEl.classList.add('hidden');
    }

    this.drawCtrl.clear();
    this.updateSlideActivation(true);
    this.renderHud();
    this.broadcastState();
  }

  public openPresenter(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('presenter', '1');
    window.open(url.toString(), 'slidesv-presenter', 'width=1280,height=760');
    setTimeout(() => this.broadcastState(), 350);
  }

  public toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  public toggleOverview(): void {
    this.overviewOpen = !this.overviewOpen;
    this.overviewEl.classList.toggle('hidden', !this.overviewOpen);
    if (this.overviewOpen) {
      this.renderOverview();
    }
  }

  private renderAll(): void {
    this.buildSlideFrames();
    this.renderStarter();
    this.updateSlideActivation(true);
    this.renderHud();
    if (this.overviewOpen) this.renderOverview();
    this.broadcastState();
  }

  private buildSlideFrames(): void {
    this.slideContainer.innerHTML = '';
    this.slideFrames = [];

    for (const slide of this.deck.slides) {
      const frame = document.createElement('div');
      frame.className = 'slide-frame';
      frame.dataset.slide = String(slide.index);
      frame.dataset.transition = slide.transition;

      const grid = document.createElement('div');
      grid.className = 'slide-layers-grid';

      for (const layer of slide.layers) {
        const slot = document.createElement('div');
        slot.className = 'layer-slot';
        slot.dataset.filename = layer.meta.filename;
        slot.dataset.step = String(layer.meta.step);
        slot.dataset.band = layer.meta.band;
        slot.dataset.group = layer.meta.group ?? '';
        slot.dataset.langs = layer.meta.languages.join(',');
        slot.dataset.hasShortcuts = layer.meta.shortcuts.length > 0 ? '1' : '0';
        slot.dataset.isDefault = isLayerDefaultActive(layer.meta) ? '1' : '0';
        slot.innerHTML = layer.svgMarkup;
        grid.appendChild(slot);
      }

      frame.appendChild(grid);
      this.slideContainer.appendChild(frame);
      this.slideFrames.push(frame);
    }
  }

  private isLayerEligible(layer: ComposedLayer, stepLimit: number): boolean {
    const { meta } = layer;
    if (meta.step > stepLimit) return false;
    if (
      meta.languages.length > 0 &&
      this.activeLanguage &&
      !meta.languages.includes(this.activeLanguage)
    ) {
      return false;
    }
    if (meta.group !== null) {
      return this.groupChoices[meta.group] === meta.filename;
    }
    if (meta.shortcuts.length > 0) {
      return Boolean(this.toggles[meta.filename]);
    }
    return true;
  }

  private updateSlideActivation(resetAnimations: boolean): void {
    const isStarter = this.currentSlide === 0;
    this.starterEl.classList.toggle('hidden', !isStarter);
    this.updateHudVisibility();

    for (const frame of this.slideFrames) {
      const num = Number.parseInt(frame.dataset.slide ?? '0', 10);
      const isActive = num === this.currentSlide;
      frame.classList.toggle('active', isActive);

      if (!isActive) {
        frame.querySelectorAll('svg').forEach((svg) => {
          pauseSvgAnimations(svg);
        });
      }
    }

    this.applyVisibilityAndAnimations(resetAnimations);
  }

  private applyVisibilityAndAnimations(
    resetAnimations: boolean,
    onlyStep?: number,
  ): void {
    for (let i = 0; i < this.deck.slides.length; i += 1) {
      const slide = this.deck.slides[i];
      const frame = this.slideFrames[i];
      if (!frame) continue;

      const isActiveSlide = slide.index === this.currentSlide;
      const slots = frame.querySelectorAll<HTMLElement>('.layer-slot');

      slide.layers.forEach((layer, idx) => {
        const slot = slots[idx];
        if (!slot) return;

        const visible = this.isLayerEligible(layer, isActiveSlide ? this.currentStep : 0);
        slot.classList.toggle('layer-hidden', !visible);

        if (visible) {
          applySwitchLanguage(slot, this.activeLanguage);
        }

        if (isActiveSlide && visible && resetAnimations) {
          if (onlyStep === undefined || layer.meta.step === onlyStep) {
            slot.querySelectorAll('svg').forEach((svg) => {
              resetAndPlaySvgAnimations(svg);
            });
          }
        }
      });
    }
  }

  private updateHudVisibility(): void {
    const hide = !this.hudVisible || this.currentSlide === 0;
    this.hudEl.classList.toggle('hidden', hide);
  }

  private renderStarter(): void {
    const notesCount = this.deck.slides.filter((s) => s.notes.trim().length > 0).length;

    const langHtml =
      this.deck.languages.length > 0
        ? `
          <div class="starter-section">
            <h2>Language</h2>
            <div class="pill-row">
              ${this.deck.languages
                .map(
                  (l) => `
                  <button class="btn btn-sm btn-pill ${l === this.activeLanguage ? 'is-active' : ''}" data-action="lang" data-lang="${l}">
                    ${l.toUpperCase()}
                  </button>`,
                )
                .join('')}
            </div>
          </div>`
        : '';

    const groupsHtml =
      this.deck.groups.length > 0
        ? `
          <div class="starter-section">
            <h2>Filter Groups</h2>
            ${this.deck.groups
              .map(
                (g) => `
                <div class="group-block">
                  <div class="group-name">${g.name}</div>
                  <div class="pill-row">
                    ${g.options
                      .map((opt) => {
                        const active = this.groupChoices[g.name] === opt.layerKey;
                        const kbd = opt.shortcuts
                          .map((s) => `<kbd>${s.display}</kbd>`)
                          .join(' ');
                        return `<button class="btn btn-sm btn-pill ${active ? 'is-active' : ''}" data-action="group" data-group="${g.name}" data-key="${opt.layerKey}">
                          ${opt.title} ${kbd}
                        </button>`;
                      })
                      .join('')}
                  </div>
                </div>`,
              )
              .join('')}
          </div>`
        : '';

    const togglesHtml =
      this.deck.toggles.length > 0
        ? `
          <div class="starter-section">
            <h2>Overlay &amp; Layer Toggles</h2>
            <div class="pill-row">
              ${this.deck.toggles
                .map((t) => {
                  const active = Boolean(this.toggles[t.layerKey]);
                  const kbd = t.shortcuts
                    .map((s) => `<kbd>${s.display}</kbd>`)
                    .join(' ');
                  return `<button class="btn btn-sm ${active ? 'is-active' : ''}" data-action="toggle" data-key="${t.layerKey}">
                    ${t.title} ${kbd}
                  </button>`;
                })
                .join('')}
            </div>
          </div>`
        : '';

    this.starterEl.innerHTML = `
      <div class="starter-card">
        <div class="starter-header">
          <div class="starter-title">
            <h1>Slide 0 — Presentation Control Hub</h1>
            <p>Built ${this.deck.buildDate} • Zero-dependency SVG Presentation Engine</p>
          </div>
          <div class="starter-actions">
            <button class="btn" id="btn-open-presenter">Open Presenter View <kbd>P</kbd></button>
            <button class="btn btn-primary" id="btn-start-pres">Start Presentation →</button>
          </div>
        </div>

        <div class="starter-stats">
          <div class="stat-box">
            <div class="stat-label">Total Slides</div>
            <div class="stat-value">${this.deck.totalSlides}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Languages</div>
            <div class="stat-value">${this.deck.languages.length || 'Default'}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Speaker Notes</div>
            <div class="stat-value">${notesCount} / ${this.deck.totalSlides}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Filters &amp; Groups</div>
            <div class="stat-value">${this.deck.toggles.length + this.deck.groups.length}</div>
          </div>
        </div>

        ${langHtml}
        ${groupsHtml}
        ${togglesHtml}

        <div class="shortcuts-help">
          <span><kbd>→</kbd> <kbd>Space</kbd> Next</span>
          <span><kbd>←</kbd> Previous</span>
          <span><kbd>G</kbd> / <kbd>Esc</kbd> Overview</span>
          <span><kbd>P</kbd> Presenter</span>
          <span>Hold <kbd>L</kbd> Laser</span>
          <span><kbd>D</kbd> Draw (<kbd>C</kbd> Clear)</span>
          <span><kbd>H</kbd> Toggle HUD</span>
          <span><kbd>F</kbd> Fullscreen</span>
        </div>
      </div>
    `;

    this.starterEl
      .querySelector('#btn-start-pres')
      ?.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.().catch(() => {});
        }
        this.goToSlide(1, 0);
      });

    this.starterEl
      .querySelector('#btn-open-presenter')
      ?.addEventListener('click', () => {
        this.openPresenter();
      });

    this.starterEl
      .querySelectorAll<HTMLElement>('[data-action="lang"]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.setLanguage(btn.dataset.lang ?? '');
        });
      });

    this.starterEl
      .querySelectorAll<HTMLElement>('[data-action="group"]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.selectGroupOption(
            btn.dataset.group ?? '',
            btn.dataset.key ?? '',
          );
        });
      });

    this.starterEl
      .querySelectorAll<HTMLElement>('[data-action="toggle"]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.toggleFilter(btn.dataset.key ?? '');
        });
      });
  }

  private renderHud(): void {
    const slide =
      this.currentSlide >= 1 ? this.deck.slides[this.currentSlide - 1] : null;
    const steps = slide ? getAvailableStepsForSlide(slide, this.getSyncState()) : [0];
    const maxStep = steps[steps.length - 1] ?? 0;
    const stepText =
      slide && maxStep > 0
        ? ` (${this.currentStep}/${maxStep})`
        : '';

    const langSelect =
      this.deck.languages.length > 0
        ? `<select class="hud-select" id="hud-lang-select" title="Language">
            ${this.deck.languages
              .map(
                (l) =>
                  `<option value="${l}" ${l === this.activeLanguage ? 'selected' : ''}>${l.toUpperCase()}</option>`,
              )
              .join('')}
          </select>`
        : '';

    const toggleButtons = this.deck.toggles
      .map((t) => {
        const active = Boolean(this.toggles[t.layerKey]);
        return `<button class="btn btn-sm ${active ? 'is-active' : ''}" data-hud-toggle="${t.layerKey}" title="${t.shortcuts.map((s) => s.display).join(', ')}">${t.title}</button>`;
      })
      .join('');

    this.hudEl.innerHTML = `
      <button class="btn btn-sm" id="hud-home" title="Slide 0 Starter">⌂</button>
      <button class="btn btn-sm" id="hud-prev" title="Previous">←</button>
      <span class="hud-counter">${this.currentSlide} / ${this.deck.totalSlides}${stepText}</span>
      <button class="btn btn-sm" id="hud-next" title="Next">→</button>
      <span class="hud-sep"></span>
      ${langSelect}
      ${toggleButtons}
      <button class="btn btn-sm ${this.drawCtrl.isActive() ? 'is-active' : ''}" id="hud-draw" title="Draw (D) / Clear (C)">✏️</button>
      <button class="btn btn-sm" id="hud-grid" title="Overview Grid (G)">⊞</button>
      <button class="btn btn-sm" id="hud-presenter" title="Presenter View (P)">🖥</button>
      <button class="btn btn-sm" id="hud-fs" title="Fullscreen (F)">⛶</button>
    `;

    this.hudEl.querySelector('#hud-home')?.addEventListener('click', () => {
      this.goToSlide(0, 0);
    });
    this.hudEl.querySelector('#hud-prev')?.addEventListener('click', () => {
      this.prev();
    });
    this.hudEl.querySelector('#hud-next')?.addEventListener('click', () => {
      this.next();
    });
    this.hudEl
      .querySelector('#hud-lang-select')
      ?.addEventListener('change', (e) => {
        this.setLanguage((e.target as HTMLSelectElement).value);
      });
    this.hudEl
      .querySelectorAll<HTMLElement>('[data-hud-toggle]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.toggleFilter(btn.dataset.hudToggle ?? '');
        });
      });
    this.hudEl.querySelector('#hud-draw')?.addEventListener('click', () => {
      this.drawCtrl.toggle();
      this.renderHud();
    });
    this.hudEl.querySelector('#hud-grid')?.addEventListener('click', () => {
      this.toggleOverview();
    });
    this.hudEl
      .querySelector('#hud-presenter')
      ?.addEventListener('click', () => {
        this.openPresenter();
      });
    this.hudEl.querySelector('#hud-fs')?.addEventListener('click', () => {
      this.toggleFullscreen();
    });
  }

  private renderOverview(): void {
    this.overviewEl.innerHTML = `
      <div class="overview-header">
        <h2>Slide Overview (${this.deck.totalSlides} slides)</h2>
        <button class="btn btn-sm" id="overview-close">Close <kbd>Esc</kbd></button>
      </div>
      <div class="overview-grid" id="overview-grid"></div>
    `;

    this.overviewEl
      .querySelector('#overview-close')
      ?.addEventListener('click', () => {
        this.toggleOverview();
      });

    const grid = this.overviewEl.querySelector('#overview-grid')!;
    for (const slide of this.deck.slides) {
      const card = document.createElement('div');
      card.className = `overview-card ${slide.index === this.currentSlide ? 'current' : ''}`;

      const thumb = document.createElement('div');
      thumb.className = 'overview-thumb';
      const layersGrid = document.createElement('div');
      layersGrid.className = 'slide-layers-grid';

      for (const layer of slide.layers) {
        if (!this.isLayerEligible(layer, 0)) continue;
        const slot = document.createElement('div');
        slot.className = 'layer-slot';
        slot.innerHTML = layer.svgMarkup;
        applySwitchLanguage(slot, this.activeLanguage);
        layersGrid.appendChild(slot);
      }

      thumb.appendChild(layersGrid);

      const meta = document.createElement('div');
      meta.className = 'overview-meta';
      meta.innerHTML = `<span>${slide.title}</span><span class="overview-num">#${slide.index}</span>`;

      card.appendChild(thumb);
      card.appendChild(meta);
      card.addEventListener('click', () => {
        this.goToSlide(slide.index, 0);
      });
      grid.appendChild(card);
    }
  }
}
