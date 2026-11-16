export type LayerBand = 'underlay' | 'normal' | 'overlay';

export type TransitionType = 'fade' | 'slide' | 'zoom' | 'none';

export interface SelectorRange {
  start: number;
  end: number;
  negate: boolean;
}

export interface ParsedSelector {
  raw: string;
  ranges: SelectorRange[];
  hasPositive: boolean;
  isGlobal: boolean;
}

export interface ParsedShortcut {
  raw: string;
  modifiers: string[];
  key: string;
  display: string;
  signature: string;
}

export interface ParsedLayerMeta {
  filename: string;
  selector: ParsedSelector;
  title: string;
  rawTitle: string;
  band: LayerBand;
  zIndex: number;
  step: number;
  transition: TransitionType;
  group: string | null;
  isDefault: boolean;
  languages: string[];
  shortcuts: ParsedShortcut[];
}

export interface ParsedSidecarMeta {
  filename: string;
  selector: ParsedSelector;
  title: string;
  rawTitle: string;
  ext: 'md' | 'txt';
}

export interface LayerInput {
  meta: ParsedLayerMeta;
  svgContent: string;
}

export interface SidecarInput {
  meta: ParsedSidecarMeta;
  content: string;
}

export interface ComposedLayer {
  id: string;
  meta: ParsedLayerMeta;
  svgMarkup: string;
  order: number;
}

export interface ComposedSlide {
  index: number;
  title: string;
  transition: TransitionType;
  maxStep: number;
  layers: ComposedLayer[];
  notes: string;
}

export interface FilterGroupInfo {
  name: string;
  options: {
    layerKey: string;
    title: string;
    isDefault: boolean;
    shortcuts: ParsedShortcut[];
  }[];
}

export interface ToggleFilterInfo {
  layerKey: string;
  title: string;
  isDefault: boolean;
  shortcuts: ParsedShortcut[];
}

export interface DeckData {
  totalSlides: number;
  slides: ComposedSlide[];
  languages: string[];
  groups: FilterGroupInfo[];
  toggles: ToggleFilterInfo[];
  buildDate: string;
}
