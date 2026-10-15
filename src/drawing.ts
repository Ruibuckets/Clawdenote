import type { ImageItem, InkItem, PageModel, Point, ShapeItem, StrokeItem, TextItem } from './model';
import { getStrokeBounds, getStrokePath, getStrokeSamples, strokeRadius, type InkPathCommand } from './ink';
export { strokeRadius } from './ink';

export interface ItemBounds { x: number; y: number; w: number; h: number }
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
interface CachedImage { image: HTMLImageElement; ready: Promise<HTMLImageElement> }
const imageCache = new Map<string, CachedImage>();
const imageListeners = new Set<() => void>();
let measureContext: CanvasRenderingContext2D | null | undefined;
// Native paths replay in the graphics engine instead of sending thousands of
// JS canvas calls again for thumbnails, zoom changes, and completed-page paints.
// Keys are derived geometry arrays, so appended live points invalidate naturally.
const nativeStrokePaths = new WeakMap<readonly InkPathCommand[], Path2D>();

function imageFor(dataUrl: string): CachedImage {
  const cached = imageCache.get(dataUrl);
  if (cached) return cached;
  const image = new window.Image();
  const ready = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => { resolve(image); for (const listener of imageListeners) listener(); };
    image.onerror = () => reject(new Error('An embedded image could not be decoded.'));
  });
  // Drawing starts loading immediately; preloadImages gives exports the rejection.
  void ready.catch(() => undefined);
  image.src = dataUrl;
  const entry = { image, ready };
  imageCache.set(dataUrl, entry);
  return entry;
}

/** Release decoded image resources when opening a different notebook. */
export function clearImageCache(): void { imageCache.clear(); }

export async function preloadImages(items: readonly InkItem[]): Promise<void> {
  await Promise.all(items.filter((item): item is ImageItem => item.type === 'image').map(item => imageFor(item.dataUrl).ready));
}

/** Request another canvas repaint when an embedded image finishes loading. */
export function subscribeToImageLoads(listener: () => void): () => void {
  imageListeners.add(listener);
  return () => { imageListeners.delete(listener); };
}

export function drawPaper(ctx: CanvasRenderingContext2D, page: PageModel): void {
  ctx.save();
  ctx.fillStyle = page.paperColor;
  ctx.fillRect(0, 0, page.width, page.height);
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = '#c7d5e3';
  if (page.paper === 'lined') {
    ctx.beginPath();
    for (let y = 68; y < page.height - 28; y += 28) { ctx.moveTo(36, y); ctx.lineTo(page.width - 36, y); }
    ctx.stroke();
    ctx.strokeStyle = '#edbdc3';
    ctx.beginPath(); ctx.moveTo(76, 40); ctx.lineTo(76, page.height - 28); ctx.stroke();
  } else if (page.paper === 'graph') {
    ctx.beginPath();
    for (let x = 0; x < page.width; x += 20) { ctx.moveTo(x, 0); ctx.lineTo(x, page.height); }
    for (let y = 0; y < page.height; y += 20) { ctx.moveTo(0, y); ctx.lineTo(page.width, y); }
    ctx.stroke();
    ctx.strokeStyle = '#a8bfd6'; ctx.lineWidth = 0.9; ctx.beginPath();
    for (let x = 0; x < page.width; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, page.height); }
    for (let y = 0; y < page.height; y += 100) { ctx.moveTo(0, y); ctx.lineTo(page.width, y); }
    ctx.stroke();
  } else if (page.paper === 'dot') {
    ctx.fillStyle = '#b5c4d3';
    ctx.beginPath();
    for (let y = 20; y < page.height; y += 20) {
      for (let x = 20; x < page.width; x += 20) { ctx.moveTo(x + 0.9, y); ctx.arc(x, y, 0.9, 0, Math.PI * 2); }
    }
    ctx.fill();
  }
  ctx.restore();
}

/** One shared ribbon path prevents differences between live ink and exported ink. */
function replayStrokePath(commands: readonly InkPathCommand[], path: Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'closePath'>): void {
  for (const command of commands) {
    if (command.type === 'move') path.moveTo(command.x, command.y);
    else if (command.type === 'line') path.lineTo(command.x, command.y);
    else if (command.type === 'cubic') path.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
    else path.closePath();
  }
}

function fillStroke(ctx: CanvasRenderingContext2D, stroke: StrokeItem): void {
  const commands = getStrokePath(stroke);
  if (typeof Path2D === 'function') {
    let native = nativeStrokePaths.get(commands);
    if (!native) {
      native = new Path2D();
      replayStrokePath(commands, native);
      nativeStrokePaths.set(commands, native);
    }
    ctx.fill(native, 'nonzero');
  } else {
    // Non-browser renderers and test contexts can still replay the same vector
    // commands; Canvas, SVG, and PDF retain one common geometry definition.
    ctx.beginPath(); replayStrokePath(commands, ctx); ctx.fill('nonzero');
  }
}

function arrowLines(item: ShapeItem): [number, number, number, number][] {
  const endX = item.x + item.w;
  const endY = item.y + item.h;
  const lines: [number, number, number, number][] = [[item.x, item.y, endX, endY]];
  const length = Math.hypot(item.w, item.h);
  if (length < 0.001) return lines;
  const angle = Math.atan2(item.h, item.w);
  const head = Math.min(Math.max(12, item.width * 4), length * 0.45);
  for (const direction of [-1, 1]) {
    const headAngle = angle + direction * Math.PI / 6;
    lines.push([endX, endY, endX - head * Math.cos(headAngle), endY - head * Math.sin(headAngle)]);
  }
  return lines;
}

export function drawItem(ctx: CanvasRenderingContext2D, item: InkItem): void {
  ctx.save();
  if (item.type === 'stroke') {
    if (item.points.length) {
      ctx.fillStyle = item.color;
      if (item.tool === 'highlighter') ctx.globalAlpha *= 0.3;
      fillStroke(ctx, item);
    }
  } else if (item.type === 'shape') {
    ctx.strokeStyle = item.color; ctx.lineWidth = item.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (item.shape === 'line' || item.shape === 'arrow') {
      const lines = item.shape === 'arrow' ? arrowLines(item) : [[item.x, item.y, item.x + item.w, item.y + item.h]];
      for (const [x1, y1, x2, y2] of lines) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    } else if (item.shape === 'rectangle') {
      ctx.rect(item.x, item.y, item.w, item.h);
    } else if (item.w !== 0 && item.h !== 0) {
      ctx.ellipse(item.x + item.w / 2, item.y + item.h / 2, Math.abs(item.w / 2), Math.abs(item.h / 2), 0, 0, Math.PI * 2);
    } else { ctx.moveTo(item.x, item.y); ctx.lineTo(item.x + item.w, item.y + item.h); }
    ctx.stroke();
  } else if (item.type === 'text') {
    ctx.fillStyle = item.color; ctx.font = `${item.fontSize}px ${FONT_FAMILY}`; ctx.textBaseline = 'top';
    item.text.split(/\r?\n/).forEach((line, index) => ctx.fillText(line, item.x, item.y + index * item.fontSize * 1.35));
  } else {
    const image = imageFor(item.dataUrl).image;
    if (image.complete && image.naturalWidth > 0) ctx.drawImage(image, item.x, item.y, item.w, item.h);
  }
  ctx.restore();
}

export function drawItems(ctx: CanvasRenderingContext2D, items: readonly InkItem[]): void {
  for (const item of items) drawItem(ctx, item);
}

export function renderPage(page: PageModel, background?: HTMLCanvasElement | HTMLImageElement, scale = 1): HTMLCanvasElement {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Page render scale must be greater than zero.');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(page.width * scale));
  canvas.height = Math.max(1, Math.round(page.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The page canvas could not be created.');
  ctx.scale(scale, scale);
  drawPaper(ctx, page);
  if (background) ctx.drawImage(background, 0, 0, page.width, page.height);
  drawItems(ctx, page.items);
  return canvas;
}

function normalizedBounds(x: number, y: number, w: number, h: number, pad = 0): ItemBounds {
  return { x: Math.min(x, x + w) - pad, y: Math.min(y, y + h) - pad, w: Math.abs(w) + pad * 2, h: Math.abs(h) + pad * 2 };
}

function textBounds(item: TextItem): ItemBounds {
  if (measureContext === undefined) measureContext = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  const lines = item.text.split(/\r?\n/);
  if (measureContext) measureContext.font = `${item.fontSize}px ${FONT_FAMILY}`;
  const widths = lines.map(line => measureContext ? measureContext.measureText(line).width : [...line].length * item.fontSize * 0.6);
  return { x: item.x, y: item.y, w: Math.max(item.fontSize * 0.35, ...widths), h: Math.max(item.fontSize, lines.length * item.fontSize * 1.35) };
}

export function itemBounds(item: InkItem): ItemBounds {
  if (item.type === 'stroke') {
    return getStrokeBounds(item);
  }
  if (item.type === 'text') return textBounds(item);
  if (item.type === 'shape' && item.shape === 'arrow') {
    const coordinates = arrowLines(item).flatMap(([x1, y1, x2, y2]) => [[x1, y1], [x2, y2]]);
    const xs = coordinates.map(point => point[0]);
    const ys = coordinates.map(point => point[1]);
    return normalizedBounds(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), item.width / 2);
  }
  return normalizedBounds(item.x, item.y, item.w, item.h, item.type === 'shape' ? item.width / 2 : 0);
}

function segmentDistance(x: number, y: number, x1: number, y1: number, x2: number, y2: number): { distance: number; fraction: number } {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return { distance: Math.hypot(x - x1 - fraction * dx, y - y1 - fraction * dy), fraction };
}

function ellipseDistance(x: number, y: number, item: ShapeItem): number {
  const rx = Math.abs(item.w / 2), ry = Math.abs(item.h / 2);
  if (rx === 0 || ry === 0) return segmentDistance(x, y, item.x, item.y, item.x + item.w, item.y + item.h).distance;
  const px = Math.abs(x - item.x - item.w / 2), py = Math.abs(y - item.y - item.h / 2);
  const distanceAt = (angle: number) => Math.hypot(rx * Math.cos(angle) - px, ry * Math.sin(angle) - py);
  const step = Math.PI / 48;
  let best = 0, distance = Infinity;
  // Find the nearest part of the ellipse, including both axes for interior hits.
  for (let index = 0; index <= 24; index++) {
    const candidate = distanceAt(index * step);
    if (candidate < distance) { best = index * step; distance = candidate; }
  }
  let low = Math.max(0, best - step), high = Math.min(Math.PI / 2, best + step);
  for (let index = 0; index < 20; index++) {
    const a = low + (high - low) / 3, b = high - (high - low) / 3;
    if (distanceAt(a) < distanceAt(b)) high = b; else low = a;
  }
  return Math.min(distance, distanceAt((low + high) / 2));
}

/** Stroke/shape erasing follows visible geometry, never just a bounding rectangle. */
export function hitTest(item: InkItem, x: number, y: number, tolerance = 6): boolean {
  const radius = Math.max(0, tolerance);
  const bounds = itemBounds(item);
  if (x < bounds.x - radius || y < bounds.y - radius || x > bounds.x + bounds.w + radius || y > bounds.y + bounds.h + radius) return false;
  if (item.type === 'stroke') {
    const samples = getStrokeSamples(item);
    if (samples.length === 1) return Math.hypot(x - samples[0].x, y - samples[0].y) <= radius + strokeRadius(item, samples[0]);
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1], point = samples[index];
      const hit = segmentDistance(x, y, previous.x, previous.y, point.x, point.y);
      const localRadius = strokeRadius(item, previous) * (1 - hit.fraction) + strokeRadius(item, point) * hit.fraction;
      if (hit.distance <= radius + localRadius) return true;
    }
    return false;
  }
  if (item.type !== 'shape') return true;
  const threshold = radius + item.width / 2;
  if (item.shape === 'ellipse') return ellipseDistance(x, y, item) <= threshold;
  const lines: [number, number, number, number][] = item.shape === 'arrow' ? arrowLines(item)
    : item.shape === 'rectangle' ? [
      [item.x, item.y, item.x + item.w, item.y],
      [item.x + item.w, item.y, item.x + item.w, item.y + item.h],
      [item.x + item.w, item.y + item.h, item.x, item.y + item.h],
      [item.x, item.y + item.h, item.x, item.y],
    ] : [[item.x, item.y, item.x + item.w, item.y + item.h]];
  return lines.some(([x1, y1, x2, y2]) => segmentDistance(x, y, x1, y1, x2, y2).distance <= threshold);
}

export function translateItem(item: InkItem, dx: number, dy: number): InkItem {
  return item.type === 'stroke' ? { ...item, points: item.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy })) }
    : { ...item, x: item.x + dx, y: item.y + dy };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function n(value: number): string { return String(Math.round(value * 1000) / 1000); }

function strokeSvgPath(item: StrokeItem): string {
  const commands: string[] = [];
  const path = {
    moveTo(x: number, y: number) { commands.push(`M${n(x)} ${n(y)}`); },
    lineTo(x: number, y: number) { commands.push(`L${n(x)} ${n(y)}`); },
    bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
      commands.push(`C${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x)} ${n(y)}`);
    },
    closePath() { commands.push('Z'); },
  };
  replayStrokePath(getStrokePath(item), path);
  return commands.join(' ');
}

/** Vector annotations for SVG export, sharing the canvas pressure outline. */
export function itemsToSvg(items: readonly InkItem[]): string {
  return items.map(item => {
    if (item.type === 'stroke') return `<path d="${strokeSvgPath(item)}" fill="${escapeXml(item.color)}"${item.tool === 'highlighter' ? ' opacity="0.3"' : ''}/>`;
    if (item.type === 'image') {
      const bounds = normalizedBounds(item.x, item.y, item.w, item.h);
      return `<image x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.w)}" height="${n(bounds.h)}" href="${escapeXml(item.dataUrl)}" preserveAspectRatio="none"/>`;
    }
    if (item.type === 'text') {
      const lines = item.text.split(/\r?\n/).map((line, index) => `<tspan x="${n(item.x)}" y="${n(item.y + item.fontSize * 0.85 + index * item.fontSize * 1.35)}">${escapeXml(line)}</tspan>`).join('');
      return `<text font-family="${FONT_FAMILY}" font-size="${n(item.fontSize)}" fill="${escapeXml(item.color)}">${lines}</text>`;
    }
    const attributes = `fill="none" stroke="${escapeXml(item.color)}" stroke-width="${n(item.width)}" stroke-linecap="round" stroke-linejoin="round"`;
    if (item.shape === 'ellipse') return `<ellipse cx="${n(item.x + item.w / 2)}" cy="${n(item.y + item.h / 2)}" rx="${n(Math.abs(item.w / 2))}" ry="${n(Math.abs(item.h / 2))}" ${attributes}/>`;
    if (item.shape === 'rectangle') {
      const bounds = normalizedBounds(item.x, item.y, item.w, item.h);
      return `<rect x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.w)}" height="${n(bounds.h)}" ${attributes}/>`;
    }
    const lines = item.shape === 'arrow' ? arrowLines(item) : [[item.x, item.y, item.x + item.w, item.y + item.h]];
    return `<path d="${lines.map(([x1, y1, x2, y2]) => `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`).join(' ')}" ${attributes}/>`;
  }).join('\n');
}

export function pageToSvg(page: PageModel, backgroundDataUrl?: string): string {
  const marks: string[] = [];
  if (page.paper === 'lined') {
    for (let y = 68; y < page.height - 28; y += 28) marks.push(`<path d="M36 ${y}H${page.width - 36}"/>`);
    marks.push(`<path d="M76 40V${page.height - 28}" stroke="#edbdc3"/>`);
  } else if (page.paper === 'graph') {
    for (let x = 0; x < page.width; x += 20) marks.push(`<path d="M${x} 0V${page.height}"${x % 100 === 0 ? ' stroke="#a8bfd6" stroke-width="0.9"' : ''}/>`);
    for (let y = 0; y < page.height; y += 20) marks.push(`<path d="M0 ${y}H${page.width}"${y % 100 === 0 ? ' stroke="#a8bfd6" stroke-width="0.9"' : ''}/>`);
  } else if (page.paper === 'dot') {
    for (let y = 20; y < page.height; y += 20) for (let x = 20; x < page.width; x += 20) marks.push(`<circle cx="${x}" cy="${y}" r="0.9" fill="#b5c4d3" stroke="none"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="${escapeXml(page.paperColor)}"/><g fill="none" stroke="#c7d5e3" stroke-width="0.7">${marks.join('')}</g>${backgroundDataUrl ? `<image width="${page.width}" height="${page.height}" href="${escapeXml(backgroundDataUrl)}"/>` : ''}${itemsToSvg(page.items)}</svg>`;
}
