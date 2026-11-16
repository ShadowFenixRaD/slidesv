import type { ComposedLayer, ComposedSlide, ParsedShortcut } from '../core/types.ts';

export interface SyncStatePayload {
  currentSlide: number;
  currentStep: number;
  activeLanguage: string;
  groupChoices: Record<string, string>;
  toggles: Record<string, boolean>;
}

export interface LaserPayload {
  active: boolean;
  x: number;
  y: number;
}

export type SyncMessage =
  | { type: 'state'; payload: SyncStatePayload }
  | { type: 'request-state' }
  | { type: 'nav'; action: 'next' | 'prev' | 'goto'; slide?: number; step?: number }
  | { type: 'set-language'; lang: string }
  | { type: 'set-group'; group: string; layerKey: string }
  | { type: 'toggle-filter'; layerKey: string }
  | { type: 'laser'; payload: LaserPayload };

export function eventMatchesShortcut(e: KeyboardEvent, sc: ParsedShortcut): boolean {
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

export function isLayerEligibleForState(
  layer: ComposedLayer,
  state: Pick<SyncStatePayload, 'activeLanguage' | 'groupChoices' | 'toggles'>,
): boolean {
  const { meta } = layer;
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

export function getAvailableStepsForSlide(
  slide: ComposedSlide,
  state: Pick<SyncStatePayload, 'activeLanguage' | 'groupChoices' | 'toggles'>,
): number[] {
  const stepSet = new Set<number>([0]);
  for (const layer of slide.layers) {
    if (layer.meta.step > 0 && isLayerEligibleForState(layer, state)) {
      stepSet.add(layer.meta.step);
    }
  }
  return Array.from(stepSet).sort((a, b) => a - b);
}

export class SyncBus {
  private channel: BroadcastChannel | null = null;
  private storageKey = 'slidesv_sync_msg';
  private listeners: Array<(msg: SyncMessage) => void> = [];

  constructor(channelName = 'slidesv-sync') {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(channelName);
        this.channel.onmessage = (ev: MessageEvent) => {
          if (ev.data && typeof ev.data === 'object') {
            this.emit(ev.data as SyncMessage);
          }
        };
      } catch {
        this.channel = null;
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (ev: StorageEvent) => {
        if (ev.key === this.storageKey && ev.newValue) {
          try {
            const parsed = JSON.parse(ev.newValue) as { msg: SyncMessage };
            if (parsed && parsed.msg) {
              this.emit(parsed.msg);
            }
          } catch {
            // ignore malformed storage payload
          }
        }
      });
    }
  }

  onMessage(cb: (msg: SyncMessage) => void): void {
    this.listeners.push(cb);
  }

  send(msg: SyncMessage): void {
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch {
        // ignore channel errors
      }
    }
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ ts: Date.now(), rand: Math.random(), msg }),
      );
    } catch {
      // ignore storage quota/security errors
    }
  }

  private emit(msg: SyncMessage): void {
    for (const cb of this.listeners) {
      cb(msg);
    }
  }
}

export function matchLanguageTag(attrValue: string, activeLang: string): boolean {
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

export function applySwitchLanguage(root: Element, activeLang: string): void {
  const switches = root.querySelectorAll('switch');
  switches.forEach((sw) => {
    const children = Array.from(sw.children);
    let matched: Element | null = null;
    let fallback: Element | null = null;

    for (const child of children) {
      const langAttr = child.getAttribute('data-system-language');
      if (langAttr === null) {
        if (!fallback) fallback = child;
      } else if (!matched && matchLanguageTag(langAttr, activeLang)) {
        matched = child;
      }
    }

    const winner = matched ?? fallback;
    for (const child of children) {
      const el = child as SVGElement | HTMLElement;
      if (child === winner) {
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    }
  });
}

export function resetAndPlaySvgAnimations(svg: SVGSVGElement): void {
  try {
    if (typeof svg.pauseAnimations === 'function') {
      svg.pauseAnimations();
    }
    if (typeof svg.setCurrentTime === 'function') {
      svg.setCurrentTime(0);
    }
    if (typeof svg.unpauseAnimations === 'function') {
      svg.unpauseAnimations();
    }
  } catch {
    // Some browsers throw if SVG is detached
  }
}

export function pauseSvgAnimations(svg: SVGSVGElement): void {
  try {
    if (typeof svg.pauseAnimations === 'function') {
      svg.pauseAnimations();
    }
  } catch {
    // ignore
  }
}

export class DrawingController {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private active = false;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
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

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.ctx) {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  toggle(): boolean {
    this.active = !this.active;
    this.canvas.classList.toggle('drawing-active', this.active);
    return this.active;
  }

  isActive(): boolean {
    return this.active;
  }

  clear(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

export class LaserController {
  private dot: HTMLElement;
  private holding = false;
  private bus: SyncBus;
  private lastX = 0.5;
  private lastY = 0.5;

  constructor(dot: HTMLElement, bus: SyncBus) {
    this.dot = dot;
    this.bus = bus;

    window.addEventListener('mousemove', (e) => {
      this.lastX = e.clientX / Math.max(1, window.innerWidth);
      this.lastY = e.clientY / Math.max(1, window.innerHeight);
      if (this.holding) {
        this.showAt(this.lastX, this.lastY, true);
      }
    });
  }

  setHolding(holding: boolean): void {
    if (this.holding === holding) return;
    this.holding = holding;
    if (holding) {
      this.showAt(this.lastX, this.lastY, true);
    } else {
      this.hide(true);
    }
  }

  showAt(normX: number, normY: number, broadcast: boolean): void {
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

  hide(broadcast: boolean): void {
    this.dot.classList.add('hidden');
    if (broadcast) {
      this.bus.send({
        type: 'laser',
        payload: { active: false, x: this.lastX, y: this.lastY },
      });
    }
  }
}
