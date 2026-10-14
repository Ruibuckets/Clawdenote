/** A4 at 96 dpi. Page coordinates stay independent of display zoom. */
export const A4_WIDTH = 794;
export const A4_HEIGHT = 1123;

export type PaperType = 'blank' | 'lined' | 'graph' | 'dot';
export type ShapeType = 'line' | 'arrow' | 'rectangle' | 'ellipse';
export interface Point { x: number; y: number; pressure: number }
export interface StrokeItem {
  id: string;
  type: 'stroke';
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: Point[];
  /** Stroke stabilization strength, 0 to 1. Missing values use the default. */
  smoothing?: number;
}
export interface ShapeItem {
  id: string;
  type: 'shape';
  shape: ShapeType;
  color: string;
  width: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TextItem {
  id: string;
  type: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}
export interface ImageItem {
  id: string;
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
}
export type InkItem = StrokeItem | ShapeItem | TextItem | ImageItem;
// Short aliases are convenient in consumers and preserve the item discriminants.
export type Stroke = StrokeItem;
export type Shape = ShapeItem;
export type Text = TextItem;
export type Image = ImageItem;
export interface PageModel {
  id: string;
  width: number;
  height: number;
  paper: PaperType;
  paperColor: string;
  items: InkItem[];
  pdf?: { sourceId: string; pageIndex: number };
  label?: string;
}
export interface DocumentModel {
  version: 1;
  id: string;
  title: string;
  pages: PageModel[];
  /** Embedded PDF bytes encoded as base64, indexed by their source IDs. */
  pdfSources: Record<string, string>;
  updatedAt: string;
}

export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPage(paper?: PaperType, paperColor?: string): PageModel;
export function createPage(options?: Partial<Pick<PageModel, 'paper' | 'paperColor' | 'width' | 'height' | 'label'>>): PageModel;
export function createPage(
  paperOrOptions: PaperType | Partial<Pick<PageModel, 'paper' | 'paperColor' | 'width' | 'height' | 'label'>> = 'blank',
  paperColor = '#ffffff',
): PageModel {
  const options = typeof paperOrOptions === 'string' ? { paper: paperOrOptions, paperColor } : paperOrOptions;
  const page: PageModel = {
    id: createId(), width: options.width ?? A4_WIDTH, height: options.height ?? A4_HEIGHT,
    paper: options.paper ?? 'blank', paperColor: options.paperColor ?? '#ffffff', items: [],
  };
  if (options.label !== undefined) page.label = options.label;
  return page;
}

export function createDocument(title = 'Untitled notebook'): DocumentModel {
  return { version: 1, id: createId(), title, pages: [createPage()], pdfSources: {}, updatedAt: new Date().toISOString() };
}

/** A duplicated page receives fresh IDs and independent mutable point arrays. */
export function clonePage(page: PageModel): PageModel {
  return {
    ...page,
    id: createId(),
    ...(page.pdf ? { pdf: { ...page.pdf } } : {}),
    items: page.items.map(item => item.type === 'stroke'
      ? { ...item, id: createId(), points: item.points.map(point => ({ ...point })) }
      : { ...item, id: createId() }),
  };
}

function invalid(location: string, expected: string): never {
  throw new Error(`Invalid Clawdenote file: ${location} must be ${expected}.`);
}
function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(location, 'an object');
  return value as Record<string, unknown>;
}
function string(value: unknown, location: string, maxLength = 1_000_000): string {
  if (typeof value !== 'string' || value.length > maxLength) invalid(location, `text of at most ${maxLength.toLocaleString()} characters`);
  return value;
}
function id(value: unknown, location: string): string {
  const result = string(value, location, 256);
  if (!result.trim()) invalid(location, 'a nonempty ID');
  return result;
}
function number(value: unknown, location: string, min = -100_000, max = 100_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(location, `a number from ${min} to ${max}`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], location: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(location, values.join(', '));
  return value as T;
}
function color(value: unknown, location: string): string {
  const result = string(value, location, 128);
  if (!result.trim()) invalid(location, 'a color');
  return result;
}

/**
 * Validate project files at the import boundary. Never trust JSON type assertions;
 * this creates a clean copy and rejects corrupt geometry before canvas/PDF use.
 */
export function validateDocument(input: unknown): DocumentModel {
  const document = record(input, 'document');
  if (document.version !== 1) invalid('version', '1 (a supported Clawdenote document version)');
  const sources = record(document.pdfSources, 'pdfSources');
  const pdfSources: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [sourceId, source] of Object.entries(sources)) {
    id(sourceId, 'PDF source ID');
    pdfSources[sourceId] = string(source, `PDF source ${sourceId}`, 300_000_000);
  }
  if (!Array.isArray(document.pages) || document.pages.length < 1 || document.pages.length > 1000) invalid('pages', 'an array with 1 to 1,000 pages');
  const pageIds = new Set<string>();
  const itemIds = new Set<string>();
  let pointCount = 0;
  const pages = document.pages.map((inputPage, pageIndex): PageModel => {
    const location = `page ${pageIndex + 1}`;
    const raw = record(inputPage, location);
    const pageId = id(raw.id, `${location} ID`);
    if (pageIds.has(pageId)) invalid(`${location} ID`, 'unique');
    pageIds.add(pageId);
    if (!Array.isArray(raw.items) || raw.items.length > 100_000) invalid(`${location} items`, 'an array with at most 100,000 items');
    const items = raw.items.map((inputItem, itemIndex): InkItem => {
      const at = `${location}, item ${itemIndex + 1}`;
      const item = record(inputItem, at);
      const itemId = id(item.id, `${at} ID`);
      if (itemIds.has(itemId)) invalid(`${at} ID`, 'unique');
      itemIds.add(itemId);
      const type = choice(item.type, ['stroke', 'shape', 'text', 'image'] as const, `${at} type`);
      if (type === 'stroke') {
        if (!Array.isArray(item.points) || item.points.length < 1) invalid(`${at} points`, 'a nonempty array');
        pointCount += item.points.length;
        if (pointCount > 5_000_000) invalid('stroke points', 'at most 5,000,000 points in one document');
        return {
          id: itemId, type, tool: choice(item.tool, ['pen', 'highlighter'] as const, `${at} tool`),
          color: color(item.color, `${at} color`), width: number(item.width, `${at} width`, 0.1, 1000),
          ...(item.smoothing === undefined ? {} : { smoothing: number(item.smoothing, `${at} smoothing`, 0, 1) }),
          points: item.points.map((inputPoint, pointIndex): Point => {
            const point = record(inputPoint, `${at}, point ${pointIndex + 1}`);
            return { x: number(point.x, `${at} point x`), y: number(point.y, `${at} point y`), pressure: number(point.pressure, `${at} pressure`, 0, 1) };
          }),
        };
      }
      const x = number(item.x, `${at} x`);
      const y = number(item.y, `${at} y`);
      if (type === 'text') return {
        id: itemId, type, x, y, text: string(item.text, `${at} text`),
        color: color(item.color, `${at} color`), fontSize: number(item.fontSize, `${at} font size`, 1, 4000),
      };
      const w = number(item.w, `${at} w`);
      const h = number(item.h, `${at} h`);
      if (type === 'shape') return {
        id: itemId, type, x, y, w, h,
        shape: choice(item.shape, ['line', 'arrow', 'rectangle', 'ellipse'] as const, `${at} shape`),
        color: color(item.color, `${at} color`), width: number(item.width, `${at} width`, 0.1, 1000),
      };
      const dataUrl = string(item.dataUrl, `${at} image`, 100_000_000);
      if (!/^data:image\/(png|jpe?g|webp|gif|bmp|avif);base64,/i.test(dataUrl)) invalid(`${at} image`, 'an embedded PNG, JPEG, WebP, GIF, BMP, or AVIF image');
      if (w === 0 || h === 0) invalid(`${at} image dimensions`, 'nonzero');
      return { id: itemId, type, x, y, w, h, dataUrl };
    });
    const page: PageModel = {
      id: pageId, width: number(raw.width, `${location} width`, 1, 20_000),
      height: number(raw.height, `${location} height`, 1, 20_000),
      paper: choice(raw.paper, ['blank', 'lined', 'graph', 'dot'] as const, `${location} paper`),
      paperColor: color(raw.paperColor, `${location} paper color`), items,
    };
    if (raw.label !== undefined) page.label = string(raw.label, `${location} label`, 1000);
    if (raw.pdf !== undefined) {
      const pdf = record(raw.pdf, `${location} PDF`);
      const sourceId = id(pdf.sourceId, `${location} PDF source ID`);
      if (!Object.hasOwn(pdfSources, sourceId)) invalid(`${location} PDF source ID`, 'a reference to an embedded PDF source');
      const pdfPage = number(pdf.pageIndex, `${location} PDF page index`, 0, 100_000);
      if (!Number.isInteger(pdfPage)) invalid(`${location} PDF page index`, 'an integer');
      page.pdf = { sourceId, pageIndex: pdfPage };
    }
    return page;
  });
  const updatedAt = string(document.updatedAt, 'updatedAt', 100);
  if (!Number.isFinite(Date.parse(updatedAt))) invalid('updatedAt', 'a valid date');
  return {
    version: 1, id: id(document.id, 'document ID'), title: string(document.title, 'title', 1000),
    pages, pdfSources, updatedAt,
  };
}
