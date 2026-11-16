(() => {
  'use strict';

  function eventMatchesShortcut(e, sc) {
    const key = e.key.toLowerCase();
    if (key !== sc.key) return false;
    const needCtrl = sc.modifiers.includes('ctrl');
    const needAlt = sc.modifiers.includes('alt');
    const needShift = sc.modifiers.includes('shift');
    const needMeta = sc.modifiers.includes('meta');
    return (
      e.ctrlKey === needCtrl &&
      e.altKey === needAlt &&
      e.shiftKey === needShift &&
      e.metaKey === needMeta
    );
  }

  function isMetaEligibleForState(meta, state) {
    if (
      meta.languages.length > 0 &&
      state.activeLanguage &&
      !meta.languages.includes(state.activeLanguage.toLowerCase())
    ) {
      return false;
    }
    if (meta.group !== null && meta.group !== undefined) {
      return state.groupChoices[meta.group] === meta.layerKey;
    }
    if (meta.shortcuts.length > 0) {
      return Boolean(state.toggles[meta.layerKey]);
    }
    return true;
  }

  function isLayerEligibleForState(layer, state) {
    if (layer.subLayers && layer.subLayers.length > 0) {
      return layer.subLayers.some((sub) => isMetaEligibleForState(sub, state));
    }
    return isMetaEligibleForState(layer.meta, state);
  }

  function getAvailableStepsForSlide(slide, state) {
    const stepSet = new Set([0]);
    for (const layer of slide.layers) {
      if (layer.subLayers && layer.subLayers.length > 0) {
        for (const sub of layer.subLayers) {
          if (sub.step > 0 && isMetaEligibleForState(sub, state)) {
            stepSet.add(sub.step);
          }
        }
      } else if (layer.meta.step > 0 && isMetaEligibleForState(layer.meta, state)) {
        stepSet.add(layer.meta.step);
      }
    }
    return Array.from(stepSet).sort((a, b) => a - b);
  }

  function applyManagedGroupVisibility(root, stepLimit, state) {
    const managed = root.querySelectorAll('g[data-step], g[data-lang], g[data-filter], g[data-group]');
    managed.forEach((g) => {
      let visible = true;
      const stepAttr = g.getAttribute('data-step');
      if (stepAttr !== null) {
        const gStep = Number.parseInt(stepAttr, 10);
        if (!Number.isNaN(gStep) && gStep > stepLimit) {
          visible = false;
        }
      }
      if (visible) {
        const langAttr = g.getAttribute('data-lang');
        if (langAttr && state.activeLanguage) {
          const langs = langAttr.split(',').map((s) => s.trim().toLowerCase());
          if (!langs.includes(state.activeLanguage.toLowerCase())) {
            visible = false;
          }
        }
      }
      if (visible) {
        const groupAttr = g.getAttribute('data-group');
        const filterAttr = g.getAttribute('data-filter');
        if (groupAttr) {
          visible = state.groupChoices[groupAttr] === filterAttr;
        } else if (filterAttr) {
          visible = Boolean(state.toggles[filterAttr]);
        }
      }
      g.style.display = visible ? '' : 'none';
    });
  }

  class SyncBus {
    constructor(channelName = 'slidesv-sync') {
      this.channel = null;
      this.storageKey = 'slidesv_sync_msg';
      this.listeners = [];
      this.seenIds = new Set();
      this.seenOrder = [];

      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.channel = new BroadcastChannel(channelName);
          this.channel.onmessage = (ev) => {
            const data = ev.data;
            if (data && typeof data === 'object') {
              if ('msg' in data && data.msg) {
                this.emit(data.msg, data.id);
              } else if ('type' in data) {
                this.emit(data);
              }
            }
          };
        } catch {
          this.channel = null;
        }
      }

      if (typeof window !== 'undefined' && !this.channel) {
        window.addEventListener('storage', (ev) => {
          if (ev.key === this.storageKey && ev.newValue) {
            try {
              const parsed = JSON.parse(ev.newValue);
              if (parsed && parsed.msg) {
                this.emit(parsed.msg, parsed.id);
              }
            } catch {
              // ignore malformed storage payload
            }
          }
        });
      }
    }

    onMessage(cb) {
      this.listeners.push(cb);
    }

    send(msg) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (this.channel) {
        try {
          this.channel.postMessage({ id, msg });
          return;
        } catch {
          // fallback to localStorage
        }
      }
      try {
        localStorage.setItem(
          this.storageKey,
          JSON.stringify({ id, ts: Date.now(), msg }),
        );
      } catch {
        // ignore
      }
    }

    emit(msg, id) {
      if (id) {
        if (this.seenIds.has(id)) return;
        this.seenIds.add(id);
        this.seenOrder.push(id);
        if (this.seenOrder.length > 100) {
          const oldest = this.seenOrder.shift();
          if (oldest) this.seenIds.delete(oldest);
        }
      }
      for (const cb of this.listeners) {
        cb(msg);
      }
    }
  }

  function matchLanguageTag(attrValue, activeLang) {
    if (!activeLang) return false;
    const target = activeLang.toLowerCase();
    const targetBase = target.split('-')[0];
    const candidates = attrValue
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    for (const c of candidates) {
      if (c === target || c === targetBase) return true;
      if (c.split('-')[0] === targetBase) return true;
    }
    return false;
  }

  function applySwitchLanguage(root, activeLang) {
    const switches = root.querySelectorAll('switch');
    switches.forEach((sw) => {
      const children = Array.from(sw.children);
      let matched = null;
      let fallback = null;

      for (const child of children) {
        const langAttr = child.getAttribute('data-system-language');
        if (langAttr === null) {
          if (!fallback) fallback = child;
        } else if (!matched && matchLanguageTag(langAttr, activeLang)) {
          matched = child;
        }
      }

      const winner = matched || fallback;
      for (const child of children) {
        if (child === winner) {
          child.style.display = '';
        } else {
          child.style.display = 'none';
        }
      }
    });
  }

  function resetAndPlaySvgAnimations(svg) {
    try {
      if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
      if (typeof svg.setCurrentTime === 'function') svg.setCurrentTime(0);
      if (typeof svg.unpauseAnimations === 'function') svg.unpauseAnimations();
    } catch {
      // ignore detached SVG
    }
  }

  function pauseSvgAnimations(svg) {
    try {
      if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
    } catch {
      // ignore
    }
  }

  class DrawingController {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.active = false;
      this.drawing = false;
      this.lastX = 0;
      this.lastY = 0;
      this.resize();
      window.addEventListener('resize', () => this.resize());

      this.canvas.addEventListener('pointerdown', (e) => {
        if (!this.active || !this.ctx) return;
        this.drawing = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.canvas.setPointerCapture(e.pointerId);
      });

      this.canvas.addEventListener('pointermove', (e) => {
        if (!this.active || !this.drawing || !this.ctx) return;
        this.ctx.strokeStyle = '#ff3b30';
        this.ctx.lineWidth = 3.5;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(this.lastX, this.lastY);
        this.ctx.lineTo(e.clientX, e.clientY);
        this.ctx.stroke();
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      });

      const endDraw = () => {
        this.drawing = false;
      };
      this.canvas.addEventListener('pointerup', endDraw);
      this.canvas.addEventListener('pointercancel', endDraw);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    toggle() {
      this.active = !this.active;
      this.canvas.classList.toggle('drawing-active', this.active);
      return this.active;
    }

    isActive() {
      return this.active;
    }

    clear() {
      if (!this.ctx) return;
      this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  class LaserController {
    constructor(dot, bus) {
      this.dot = dot;
      this.holding = false;
      this.bus = bus;
      this.lastX = 0.5;
      this.lastY = 0.5;

      window.addEventListener('mousemove', (e) => {
        this.lastX = e.clientX / Math.max(1, window.innerWidth);
        this.lastY = e.clientY / Math.max(1, window.innerHeight);
        if (this.holding) {
          this.showAt(this.lastX, this.lastY, true);
        }
      });
    }

    setHolding(holding) {
      if (this.holding === holding) return;
      this.holding = holding;
      if (holding) {
        this.showAt(this.lastX, this.lastY, true);
      } else {
        this.hide(true);
      }
    }

    showAt(normX, normY, broadcast) {
      this.dot.classList.remove('hidden');
      this.dot.style.left = `${normX * window.innerWidth}px`;
      this.dot.style.top = `${normY * window.innerHeight}px`;
      if (broadcast) {
        this.bus.send({
          type: 'laser',
          payload: { active: true, x: normX, y: normY },
        });
      }
    }

    hide(broadcast) {
      this.dot.classList.add('hidden');
      if (broadcast) {
        this.bus.send({
          type: 'laser',
          payload: { active: false, x: this.lastX, y: this.lastY },
        });
      }
    }
  }

  function renderSlidePreviewInto(container, deck, slideNum, stepNum, state) {
    container.innerHTML = '';
    if (slideNum < 1 || slideNum > deck.totalSlides) {
      const empty = document.createElement('div');
      empty.style.color = '#9aa5b8';
      empty.style.fontSize = '0.95rem';
      empty.textContent =
        slideNum === 0 ? 'Slide 0: Home Launcher' : 'End of Presentation';
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
      applyManagedGroupVisibility(slot, stepNum, state);
      applySwitchLanguage(slot, state.activeLanguage);

      slot.querySelectorAll('svg').forEach((svg) => {
        try {
          if (typeof svg.setCurrentTime === 'function') svg.setCurrentTime(60);
          if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
        } catch {
          // ignore
        }
      });

      grid.appendChild(slot);
    }

    container.appendChild(grid);
  }

  function mountPresenterView(deck, initialState, bus) {
    document.title = 'Presenter View — svg-deck';
    let state = {
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
            <button class="btn btn-sm" id="p-home" title="Home Launcher">⌂</button>
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

    const titleEl = document.getElementById('p-slide-title');
    const currentEl = document.getElementById('p-current-preview');
    const nextLabelEl = document.getElementById('p-next-label');
    const nextEl = document.getElementById('p-next-preview');
    const notesEl = document.getElementById('p-notes');
    const controlsEl = document.getElementById('p-controls-strip');
    const elapsedEl = document.getElementById('p-elapsed');
    const clockEl = document.getElementById('p-clock');
    const timerToggleBtn = document.getElementById('p-timer-toggle');
    const timerResetBtn = document.getElementById('p-timer-reset');

    const formatDuration = (sec) => {
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
      const parts = [];

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

      controlsEl.querySelectorAll('[data-p-lang]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const lang = btn.dataset.pLang || '';
          state.activeLanguage = lang;
          render();
          bus.send({ type: 'set-language', lang });
        });
      });

      controlsEl.querySelectorAll('[data-p-group]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const group = btn.dataset.pGroup || '';
          const layerKey = btn.dataset.pKey || '';
          state.groupChoices[group] = layerKey;
          render();
          bus.send({ type: 'set-group', group, layerKey });
        });
      });

      controlsEl.querySelectorAll('[data-p-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const layerKey = btn.dataset.pToggle || '';
          state.toggles[layerKey] = !state.toggles[layerKey];
          render();
          bus.send({ type: 'toggle-filter', layerKey });
        });
      });
    };

    const render = () => {
      const slide = state.currentSlide >= 1 ? deck.slides[state.currentSlide - 1] : null;
      const steps = slide ? getAvailableStepsForSlide(slide, state) : [0];
      const maxStep = steps[steps.length - 1] ?? 0;
      const currentStepIdx = steps.indexOf(state.currentStep);

      titleEl.textContent =
        state.currentSlide === 0
          ? `Home Launcher — ${deck.totalSlides} slides`
          : `Slide ${state.currentSlide} / ${deck.totalSlides} — ${slide?.title ?? ''} (Step ${state.currentStep}/${maxStep})`;

      renderSlidePreviewInto(currentEl, deck, state.currentSlide, state.currentStep, state);

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

      notesEl.textContent = slide?.notes || 'No speaker notes for this slide.';
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

    document.getElementById('p-home').addEventListener('click', () => {
      bus.send({ type: 'nav', action: 'goto', slide: 0, step: 0 });
    });
    document.getElementById('p-prev').addEventListener('click', () => {
      bus.send({ type: 'nav', action: 'prev' });
    });
    document.getElementById('p-next').addEventListener('click', () => {
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

  class SlidePlayer {
    constructor(deck, config = {}) {
      this.deck = deck;
      this.bus = new SyncBus();
      this.currentSlide = deck.totalSlides > 0 ? 1 : 0;
      this.currentStep = 0;
      this.activeLanguage = '';
      this.groupChoices = {};
      this.toggles = {};
      this.hudVisible = true;
      this.overviewOpen = false;
      this.slideFrames = [];

      const params = new URLSearchParams(window.location.search);
      const urlLang = params.get('language')?.toLowerCase() ?? '';
      this.activeLanguage =
        urlLang ||
        (config.lang ? config.lang.toLowerCase() : '') ||
        (deck.languages[0] ?? '');

      this.initFilterDefaults(config.filters);

      if (params.get('presenter') === '1') {
        mountPresenterView(deck, this.getSyncState(), this.bus);
        return;
      }

      const homeParam = params.get('home');
      const showHome = homeParam === '1' || homeParam === 'true';

      const slideParam = params.get('slide');
      if (slideParam !== null) {
        const n = Number.parseInt(slideParam, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= deck.totalSlides) {
          this.currentSlide = n;
        }
      } else if (showHome) {
        this.currentSlide = 0;
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

    initFilterDefaults(initialFilters) {
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

    getSyncState() {
      return {
        currentSlide: this.currentSlide,
        currentStep: this.currentStep,
        activeLanguage: this.activeLanguage,
        groupChoices: { ...this.groupChoices },
        toggles: { ...this.toggles },
      };
    }

    broadcastState() {
      this.bus.send({ type: 'state', payload: this.getSyncState() });
    }

    mountStage() {
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

      this.stageEl = document.getElementById('stage-wrapper');
      this.slideContainer = document.getElementById('slide-container');
      this.starterEl = document.getElementById('starter-view');
      this.hudEl = document.getElementById('hud-bar');
      this.overviewEl = document.getElementById('overview-modal');

      this.drawCtrl = new DrawingController(document.getElementById('draw-canvas'));
      this.laserCtrl = new LaserController(document.getElementById('laser-dot'), this.bus);
    }

    bindEvents() {
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
        if (e.target.closest('#hud-bar')) return;
        this.next();
      });

      window.addEventListener('keydown', (e) => {
        const target = e.target;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT')
        ) {
          return;
        }

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
        if (key === 'Escape' || lower === 'g') {
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

    handleCustomShortcut(e) {
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

    setLanguage(lang) {
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

    selectGroupOption(groupName, layerKey) {
      this.groupChoices[groupName] = layerKey;
      this.applyVisibilityAndAnimations(false);
      this.renderStarter();
      this.renderHud();
      this.broadcastState();
    }

    toggleFilter(layerKey) {
      this.toggles[layerKey] = !this.toggles[layerKey];
      this.applyVisibilityAndAnimations(false);
      this.renderStarter();
      this.renderHud();
      this.broadcastState();
    }

    next() {
      if (this.currentSlide === 0) {
        if (this.deck.totalSlides > 0) this.goToSlide(1, 0);
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

    prev() {
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

    goToSlide(slideNum, stepNum = 0) {
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

    openPresenter() {
      const url = new URL(window.location.href);
      url.searchParams.set('presenter', '1');
      window.open(url.toString(), 'slidesv-presenter', 'width=1280,height=760');
      setTimeout(() => this.broadcastState(), 350);
    }

    toggleFullscreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    }

    toggleOverview() {
      this.overviewOpen = !this.overviewOpen;
      this.overviewEl.classList.toggle('hidden', !this.overviewOpen);
      if (this.overviewOpen) this.renderOverview();
    }

    renderAll() {
      this.buildSlideFrames();
      this.renderStarter();
      this.updateSlideActivation(true);
      this.renderHud();
      if (this.overviewOpen) this.renderOverview();
      this.broadcastState();
    }

    buildSlideFrames() {
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
          slot.innerHTML = layer.svgMarkup;
          grid.appendChild(slot);
        }

        frame.appendChild(grid);
        this.slideContainer.appendChild(frame);
        this.slideFrames.push(frame);
      }
    }

    isLayerEligible(layer, stepLimit) {
      if (layer.meta.step > stepLimit) return false;
      return isLayerEligibleForState(layer, this.getSyncState());
    }

    updateSlideActivation(resetAnimations) {
      const isStarter = this.currentSlide === 0;
      this.starterEl.classList.toggle('hidden', !isStarter);
      this.updateHudVisibility();

      for (const frame of this.slideFrames) {
        const num = Number.parseInt(frame.dataset.slide ?? '0', 10);
        const isActive = num === this.currentSlide;
        frame.classList.toggle('active', isActive);

        if (!isActive) {
          frame.querySelectorAll('svg').forEach((svg) => pauseSvgAnimations(svg));
        }
      }

      this.applyVisibilityAndAnimations(resetAnimations);
    }

    applyVisibilityAndAnimations(resetAnimations, onlyStep) {
      for (let i = 0; i < this.deck.slides.length; i += 1) {
        const slide = this.deck.slides[i];
        const frame = this.slideFrames[i];
        if (!frame) continue;

        const isActiveSlide = slide.index === this.currentSlide;
        const slots = frame.querySelectorAll('.layer-slot');

        slide.layers.forEach((layer, idx) => {
          const slot = slots[idx];
          if (!slot) return;

          const visible = this.isLayerEligible(layer, isActiveSlide ? this.currentStep : 0);
          slot.classList.toggle('layer-hidden', !visible);

          if (visible) {
            applyManagedGroupVisibility(
              slot,
              isActiveSlide ? this.currentStep : 0,
              this.getSyncState(),
            );
            applySwitchLanguage(slot, this.activeLanguage);
          }

          if (isActiveSlide && visible && resetAnimations) {
            const isMultiLayer = layer.subLayers && layer.subLayers.length > 0;
            if (onlyStep !== undefined && onlyStep > 0 && isMultiLayer) {
              slot.querySelectorAll(`g[data-step="${onlyStep}"]`).forEach((g) => {
                g.querySelectorAll('animate, animateTransform, animateMotion, set').forEach(
                  (anim) => {
                    try {
                      if (typeof anim.beginElement === 'function') {
                        anim.beginElement();
                      }
                    } catch {
                      // ignore
                    }
                  },
                );
              });
            } else if (onlyStep === undefined || layer.meta.step === onlyStep) {
              slot.querySelectorAll('svg').forEach((svg) => resetAndPlaySvgAnimations(svg));
            }
          }
        });
      }
    }

    updateHudVisibility() {
      const hide = !this.hudVisible || this.currentSlide === 0;
      this.hudEl.classList.toggle('hidden', hide);
    }

    renderStarter() {
      const notesCount = this.deck.slides.filter((s) => s.notes.trim().length > 0).length;

      const langHtml =
        this.deck.languages.length > 0
          ? `<div class="starter-section">
              <h2>Language</h2>
              <div class="pill-row">
                ${this.deck.languages
                  .map(
                    (l) =>
                      `<button class="btn btn-sm btn-pill ${l === this.activeLanguage ? 'is-active' : ''}" data-action="lang" data-lang="${l}">${l.toUpperCase()}</button>`,
                  )
                  .join('')}
              </div>
            </div>`
          : '';

      const groupsHtml =
        this.deck.groups.length > 0
          ? `<div class="starter-section">
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
                          const kbd = opt.shortcuts.map((s) => `<kbd>${s.display}</kbd>`).join(' ');
                          return `<button class="btn btn-sm btn-pill ${active ? 'is-active' : ''}" data-action="group" data-group="${g.name}" data-key="${opt.layerKey}">${opt.title} ${kbd}</button>`;
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
          ? `<div class="starter-section">
              <h2>Overlay &amp; Layer Toggles</h2>
              <div class="pill-row">
                ${this.deck.toggles
                  .map((t) => {
                    const active = Boolean(this.toggles[t.layerKey]);
                    const kbd = t.shortcuts.map((s) => `<kbd>${s.display}</kbd>`).join(' ');
                    return `<button class="btn btn-sm ${active ? 'is-active' : ''}" data-action="toggle" data-key="${t.layerKey}">${t.title} ${kbd}</button>`;
                  })
                  .join('')}
              </div>
            </div>`
          : '';

      this.starterEl.innerHTML = `
        <div class="starter-card">
          <div class="starter-header">
            <div class="starter-title">
              <h1>Home Launcher — Presentation Control Hub</h1>
              <p>Built ${this.deck.buildDate} • svg-deck Presentation Engine</p>
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

      this.starterEl.querySelector('#btn-start-pres')?.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.().catch(() => {});
        }
        this.goToSlide(1, 0);
      });

      this.starterEl.querySelector('#btn-open-presenter')?.addEventListener('click', () => {
        this.openPresenter();
      });

      this.starterEl.querySelectorAll('[data-action="lang"]').forEach((btn) => {
        btn.addEventListener('click', () => this.setLanguage(btn.dataset.lang ?? ''));
      });

      this.starterEl.querySelectorAll('[data-action="group"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.selectGroupOption(btn.dataset.group ?? '', btn.dataset.key ?? '');
        });
      });

      this.starterEl.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
        btn.addEventListener('click', () => this.toggleFilter(btn.dataset.key ?? ''));
      });
    }

    renderHud() {
      const slide = this.currentSlide >= 1 ? this.deck.slides[this.currentSlide - 1] : null;
      const steps = slide ? getAvailableStepsForSlide(slide, this.getSyncState()) : [0];
      const maxStep = steps[steps.length - 1] ?? 0;
      const stepText = slide && maxStep > 0 ? ` (${this.currentStep}/${maxStep})` : '';

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
        <button class="btn btn-sm" id="hud-home" title="Home Launcher">⌂</button>
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

      this.hudEl.querySelector('#hud-home')?.addEventListener('click', () => this.goToSlide(0, 0));
      this.hudEl.querySelector('#hud-prev')?.addEventListener('click', () => this.prev());
      this.hudEl.querySelector('#hud-next')?.addEventListener('click', () => this.next());
      this.hudEl.querySelector('#hud-lang-select')?.addEventListener('change', (e) => {
        this.setLanguage(e.target.value);
      });
      this.hudEl.querySelectorAll('[data-hud-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => this.toggleFilter(btn.dataset.hudToggle ?? ''));
      });
      this.hudEl.querySelector('#hud-draw')?.addEventListener('click', () => {
        this.drawCtrl.toggle();
        this.renderHud();
      });
      this.hudEl.querySelector('#hud-grid')?.addEventListener('click', () => this.toggleOverview());
      this.hudEl.querySelector('#hud-presenter')?.addEventListener('click', () => this.openPresenter());
      this.hudEl.querySelector('#hud-fs')?.addEventListener('click', () => this.toggleFullscreen());
    }

    renderOverview() {
      this.overviewEl.innerHTML = `
        <div class="overview-header">
          <h2>Slide Overview (${this.deck.totalSlides} slides)</h2>
          <button class="btn btn-sm" id="overview-close">Close <kbd>Esc</kbd></button>
        </div>
        <div class="overview-grid" id="overview-grid"></div>
      `;

      this.overviewEl.querySelector('#overview-close')?.addEventListener('click', () => {
        this.toggleOverview();
      });

      const grid = this.overviewEl.querySelector('#overview-grid');
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
          applyManagedGroupVisibility(slot, 0, this.getSyncState());
          applySwitchLanguage(slot, this.activeLanguage);
          layersGrid.appendChild(slot);
        }

        thumb.appendChild(layersGrid);

        const meta = document.createElement('div');
        meta.className = 'overview-meta';
        meta.innerHTML = `<span>${slide.title}</span><span class="overview-num">#${slide.index}</span>`;

        card.appendChild(thumb);
        card.appendChild(meta);
        card.addEventListener('click', () => this.goToSlide(slide.index, 0));
        grid.appendChild(card);
      }
    }
  }

  function bootstrap() {
    if (window.__SLIDESV_DECK__) {
      const cfg = window.__SLIDESV_CONFIG__ || {};
      new SlidePlayer(window.__SLIDESV_DECK__, cfg);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
