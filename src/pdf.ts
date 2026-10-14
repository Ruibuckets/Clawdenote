import type * as MuPDF from 'mupdf';
import type { DocumentModel, PageModel, InkItem, ImageItem } from './model';
import { createId } from './model';
import { pageToSvg, preloadImages, renderPage, strokeRadius } from './drawing';

/** Coordinates are the notebook's 96 dpi page coordinates, independent of zoom. */
export interface PdfTextBlock {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  color?: string;
  fontName?: string;
  /** Original baseline and direction, retained for accurate replacement. */
  baselineX?: number;
  baselineY?: number;
  direction?: [number, number];
  editable?: boolean;
}

type Engine = typeof MuPDF;
type Rect = MuPDF.Rect;
type RGB = [number, number, number];
const PX_PER_POINT = 96 / 72;
let enginePromise: Promise<Engine> | undefined;

/** Vite emits the WASM as a local asset; nothing is fetched from a CDN. */
async function engine(): Promise<Engine> {
  if (!enginePromise) {
    const globals = globalThis as typeof globalThis & {
      $libmupdf_wasm_Module?: { locateFile: (name: string) => string };
    };
    globals.$libmupdf_wasm_Module = {
      locateFile: () => new URL('../node_modules/mupdf/dist/mupdf-wasm.wasm', import.meta.url).href,
    };
    enginePromise = import('mupdf');
  }
  return enginePromise;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function openPdf(mu: Engine, bytes: Uint8Array): MuPDF.PDFDocument {
  let document: MuPDF.Document;
  try {
    document = mu.Document.openDocument(bytes, 'application/pdf');
  } catch {
    throw new Error('This PDF could not be opened. It may be damaged or use an unsupported PDF format.');
  }
  if (document.needsPassword()) {
    document.destroy();
    throw new Error('This PDF requires a password. Save an unlocked copy in your PDF reader, then open that copy in Clawdenote.');
  }
  const pdf = document.asPDF();
  if (!pdf) {
    document.destroy();
    throw new Error('The selected file is not a PDF document.');
  }
  // Embedded PDF JavaScript is never executed by this notebook.
  pdf.disableJS();
  return pdf;
}

function sourceBytes(document: DocumentModel, page: PageModel): Uint8Array {
  if (!page.pdf || !document.pdfSources[page.pdf.sourceId]) {
    throw new Error('The original PDF data for this page is missing. Reopen the PDF to recover it.');
  }
  return base64ToBytes(document.pdfSources[page.pdf.sourceId]);
}

function saveBytes(pdf: MuPDF.PDFDocument): Uint8Array {
  // Full rewrite and garbage collection remove the old glyph streams and revisions.
  const buffer = pdf.saveToBuffer('garbage=4,compress');
  try { return buffer.asUint8Array().slice(); }
  finally { buffer.destroy(); }
}

export async function importPdf(bytes: Uint8Array, name: string): Promise<{
  pages: PageModel[]; sourceId: string; sourceData: string;
}> {
  if (bytes.length > 200_000_000) throw new Error('This PDF is larger than the 200 MB import limit. Split it into smaller PDFs first.');
  const mu = await engine();
  const pdf = openPdf(mu, bytes);
  const sourceId = createId();
  try {
    const count = pdf.countPages();
    if (count < 1) throw new Error('This PDF has no pages.');
    if (count > 1000) throw new Error('This PDF has more than 1,000 pages. Split it into smaller PDFs first.');
    const pages: PageModel[] = [];
    for (let index = 0; index < count; index++) {
      const page = pdf.loadPage(index);
      try {
        const bounds = page.getBounds();
        const width = (bounds[2] - bounds[0]) * PX_PER_POINT;
        const height = (bounds[3] - bounds[1]) * PX_PER_POINT;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 20_000 || height > 20_000) {
          throw new Error(`PDF page ${index + 1} has an unsupported page size.`);
        }
        pages.push({
          id: createId(), width, height, paper: 'blank', paperColor: '#ffffff', items: [],
          pdf: { sourceId, pageIndex: index }, label: `${name.replace(/\.pdf$/i, '')} · ${index + 1}`,
        });
      } finally { page.destroy(); }
    }
    return { pages, sourceId, sourceData: bytesToBase64(bytes) };
  } finally { pdf.destroy(); }
}

function colorHex(color: MuPDF.Color): string {
  const rgb = color.length === 1 ? [color[0], color[0], color[0]] : color.slice(0, 3);
  return '#' + rgb.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('');
}

function parseColor(value: string): RGB {
  const hex = value.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) return hex.split('').map(c => parseInt(c + c, 16) / 255) as RGB;
  if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
  return [0, 0, 0];
}

interface TextLine {
  text: string; bbox: Rect; size: number; color: string; baseline: [number, number];
  direction: [number, number]; horizontal: boolean; fontName: string; font?: MuPDF.Font;
}

/** The first font can be retained temporarily when replacing a selected line. */
function readLines(page: MuPDF.PDFPage, retainFontAt = -1): TextLine[] {
  const structured = page.toStructuredText('preserve-spans,preserve-whitespace');
  const lines: TextLine[] = [];
  let line: TextLine | undefined;
  try {
    structured.walk({
      beginLine(bbox, writingMode, direction) {
        line = {
          text: '', bbox, size: 12, color: '#000000', baseline: [bbox[0], bbox[3]],
          direction, horizontal: writingMode === 0 && Math.abs(direction[1]) < 0.01 && direction[0] > 0.99,
          fontName: 'Helvetica',
        };
      },
      onChar(char, origin, font, size, _quad, color) {
        try {
          if (!line) return;
          if (!line.text) {
            line.size = size;
            line.color = colorHex(color);
            line.baseline = origin;
            line.fontName = font.getName();
            if (lines.length === retainFontAt) line.font = font;
          }
          line.text += char;
        } finally { if (line?.font !== font) font.destroy(); }
      },
      endLine() { if (line) lines.push(line); line = undefined; },
    });
    return lines;
  } finally { structured.destroy(); }
}

function lineBlock(line: TextLine, index: number, model: PageModel, bounds: Rect): PdfTextBlock {
  const sx = model.width / (bounds[2] - bounds[0]);
  const sy = model.height / (bounds[3] - bounds[1]);
  return {
    id: `${model.id}:${index}`,
    text: line.text, x: (line.bbox[0] - bounds[0]) * sx, y: (line.bbox[1] - bounds[1]) * sy,
    w: (line.bbox[2] - line.bbox[0]) * sx, h: (line.bbox[3] - line.bbox[1]) * sy,
    fontSize: line.size * sy, color: line.color, fontName: line.fontName,
    baselineX: (line.baseline[0] - bounds[0]) * sx, baselineY: (line.baseline[1] - bounds[1]) * sy,
    direction: line.direction, editable: line.horizontal,
  };
}

export async function getPdfTextBlocks(document: DocumentModel, model: PageModel): Promise<PdfTextBlock[]> {
  if (!model.pdf) return [];
  const mu = await engine();
  const pdf = openPdf(mu, sourceBytes(document, model));
  try {
    // Include editable FreeText annotations and form text in extraction.
    pdf.bake(true, true);
    const page = pdf.loadPage(model.pdf.pageIndex);
    try {
      const bounds = page.getBounds();
      return readLines(page).map((line, index) => lineBlock(line, index, model, bounds)).filter(block => block.text.trim());
    } finally { page.destroy(); }
  } finally { pdf.destroy(); }
}

class FontSet {
  fonts = new Map<string, MuPDF.Font>();
  constructor(private mu: Engine) {}
  get(name: string): MuPDF.Font {
    let font = this.fonts.get(name);
    if (!font) { font = new this.mu.Font(name); this.fonts.set(name, font); }
    return font;
  }
  select(char: string, preferred?: MuPDF.Font): MuPDF.Font {
    const unicode = char.codePointAt(0)!;
    if (preferred && preferred.encodeCharacter(unicode) !== 0) return preferred;
    let name = 'Helvetica';
    if (preferred) {
      const bold = preferred.isBold(), italic = preferred.isItalic();
      name = preferred.isMono() ? 'Courier' : preferred.isSerif() ? 'Times-Roman' : 'Helvetica';
      if (name === 'Times-Roman' && (bold || italic)) name = bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : 'Times-Italic';
      else if (bold || italic) name += bold && italic ? '-BoldOblique' : bold ? '-Bold' : '-Oblique';
    }
    const base = this.get(name);
    if (base.encodeCharacter(unicode) !== 0) return base;
    const cjk = this.get('zh-Hans');
    if (cjk.encodeCharacter(unicode) !== 0) return cjk;
    throw new Error(`The PDF font cannot represent “${char}”. Use another character or export this page as an image.`);
  }
  destroy() { for (const font of this.fonts.values()) font.destroy(); }
}

function drawText(mu: Engine, device: MuPDF.Device, fonts: FontSet, value: string, x: number, baseline: number, size: number, color: RGB, preferred?: MuPDF.Font, maxWidth = Infinity): number {
  const chars = Array.from(value);
  const glyphs = chars.map(char => {
    const font = fonts.select(char, preferred);
    const unicode = char.codePointAt(0)!;
    const gid = font.encodeCharacter(unicode);
    return { font, unicode, gid, advance: font.advanceGlyph(gid) };
  });
  const width = glyphs.reduce((sum, glyph) => sum + glyph.advance * size, 0);
  const fitted = width > maxWidth ? size * maxWidth / width : size;
  if (fitted < 3) throw new Error('The replacement is too long for this text line. Shorten the text or use a new text box.');
  const text = new mu.Text();
  try {
    let cursor = x;
    for (const glyph of glyphs) {
      text.showGlyph(glyph.font, [fitted, 0, 0, -fitted, cursor, baseline], glyph.gid, glyph.unicode);
      cursor += glyph.advance * fitted;
    }
    device.fillText(text, mu.Matrix.identity, mu.ColorSpace.DeviceRGB, color, 1);
  } finally { text.destroy(); }
  return fitted;
}

export async function replacePdfText(document: DocumentModel, model: PageModel, block: PdfTextBlock, replacement: string): Promise<void> {
  if (!model.pdf) throw new Error('Choose an imported PDF page to edit its existing text.');
  if (/[\r\n]/.test(replacement)) throw new Error('Edit one PDF text line at a time. Use the text tool to add a multiline text box.');
  if (replacement.length > 10_000) throw new Error('The replacement text is too long.');
  const mu = await engine();
  const pdf = openPdf(mu, sourceBytes(document, model));
  let sourceFont: MuPDF.Font | undefined;
  try {
    if (!pdf.hasPermission('edit')) throw new Error('This PDF restricts text editing. Open an unrestricted copy to edit its typed text.');
    pdf.bake(true, true);
    const page = pdf.loadPage(model.pdf.pageIndex);
    try {
      const index = Number(block.id.slice(block.id.lastIndexOf(':') + 1));
      const lines = readLines(page, index);
      const line = lines[index];
      sourceFont = line?.font;
      if (!line || line.text !== block.text || !block.id.startsWith(`${model.id}:`)) throw new Error('This PDF text selection has changed. Select the line again.');
      if (!line.horizontal) throw new Error('Rotated or vertical PDF text cannot be replaced yet. You can annotate this page or add a new text box.');
      if (!line.text.trim()) throw new Error('No editable text was found. Scanned PDFs need OCR before their typed text can be edited.');

      // Build replacement before removing anything, so unsupported glyphs never mutate the notebook.
      const bounds = page.getBounds();
      const list = new mu.DisplayList(bounds);
      const device = new mu.DisplayListDevice(list);
      const fonts = new FontSet(mu);
      try {
        if (replacement) drawText(mu, device, fonts, replacement, line.baseline[0], line.baseline[1], line.size, parseColor(line.color), sourceFont, line.bbox[2] - line.bbox[0]);
        device.close();
        const redaction = page.createAnnotation('Redact');
        try {
          // A small inward epsilon prevents adjacent lines touching at their ascender boxes from disappearing.
          const rect: Rect = [line.bbox[0] + 0.01, line.bbox[1] + 0.01, line.bbox[2] - 0.01, line.bbox[3] - 0.01];
          redaction.setRect(rect);
          redaction.applyRedaction(0, mu.PDFPage.REDACT_IMAGE_NONE, mu.PDFPage.REDACT_LINE_ART_NONE, mu.PDFPage.REDACT_TEXT_REMOVE);
        } finally { redaction.destroy(); }
        if (replacement) {
          const annotation = page.createAnnotation('Stamp');
          try {
            annotation.setRect(bounds);
            annotation.setAppearanceFromDisplayList('N', null, mu.Matrix.identity, list);
          } finally { annotation.destroy(); }
        }
        pdf.bake(true, true);
        const isolated = new mu.PDFDocument();
        let nextBytes: Uint8Array;
        try {
          isolated.graftPage(-1, pdf, model.pdf.pageIndex);
          nextBytes = saveBytes(isolated);
        } finally { isolated.destroy(); }
        // Give this notebook page its own source, so edits do not change duplicated pages.
        const sourceId = createId();
        const previousSource = model.pdf.sourceId;
        document.pdfSources[sourceId] = bytesToBase64(nextBytes);
        model.pdf = { sourceId, pageIndex: 0 };
        if (!document.pages.some(page => page.pdf?.sourceId === previousSource)) delete document.pdfSources[previousSource];
        document.updatedAt = new Date().toISOString();
      } finally { device.destroy(); list.destroy(); fonts.destroy(); }
    } finally { page.destroy(); }
  } finally { sourceFont?.destroy(); pdf.destroy(); }
}

export async function renderPdfBackground(document: DocumentModel, model: PageModel, scale = 1): Promise<HTMLCanvasElement | null> {
  if (!model.pdf) return null;
  const mu = await engine();
  const pdf = openPdf(mu, sourceBytes(document, model));
  try {
    const page = pdf.loadPage(model.pdf.pageIndex);
    try {
      const bounds = page.getBounds();
      const safeScale = Math.min(Math.max(scale, 0.1), 4096 / Math.max(model.width, model.height));
      const pixmap = page.toPixmap(mu.Matrix.scale(model.width / (bounds[2] - bounds[0]) * safeScale, model.height / (bounds[3] - bounds[1]) * safeScale), mu.ColorSpace.DeviceRGB, true, true);
      try {
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = pixmap.getWidth(); canvas.height = pixmap.getHeight();
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The page canvas could not be created.');
        const pixels = new Uint8ClampedArray(pixmap.getPixels());
        // MuPDF stores premultiplied samples; ImageData expects straight RGBA.
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const alpha = pixels[offset + 3];
          if (alpha > 0 && alpha < 255) {
            pixels[offset] = pixels[offset] * 255 / alpha;
            pixels[offset + 1] = pixels[offset + 1] * 255 / alpha;
            pixels[offset + 2] = pixels[offset + 2] * 255 / alpha;
          }
        }
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
        return canvas;
      } finally { pixmap.destroy(); }
    } finally { page.destroy(); }
  } finally { pdf.destroy(); }
}

function circle(path: MuPDF.Path, x: number, y: number, radius: number) {
  const k = radius * 0.5522847498;
  path.moveTo(x + radius, y);
  path.curveTo(x + radius, y + k, x + k, y + radius, x, y + radius);
  path.curveTo(x - k, y + radius, x - radius, y + k, x - radius, y);
  path.curveTo(x - radius, y - k, x - k, y - radius, x, y - radius);
  path.curveTo(x + k, y - radius, x + radius, y - k, x + radius, y);
  path.closePath();
}

function strokePath(mu: Engine, device: MuPDF.Device, path: MuPDF.Path, color: string, width: number) {
  const state = new mu.StrokeState({ lineCap: 'Round', lineJoin: 'Round', lineWidth: width, miterLimit: 10 });
  try { device.strokePath(path, state, mu.Matrix.identity, mu.ColorSpace.DeviceRGB, parseColor(color), 1); }
  finally { state.destroy(); }
}

function drawVectorPaper(mu: Engine, device: MuPDF.Device, model: PageModel) {
  const path = new mu.Path();
  try {
    path.rect(0, 0, model.width, model.height);
    device.fillPath(path, false, mu.Matrix.identity, mu.ColorSpace.DeviceRGB, parseColor(model.paperColor), 1);
  } finally { path.destroy(); }
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number) => {
    const p = new mu.Path();
    try { p.moveTo(x1, y1); p.lineTo(x2, y2); strokePath(mu, device, p, color, width); }
    finally { p.destroy(); }
  };
  if (model.paper === 'lined') {
    for (let y = 68; y < model.height - 28; y += 28) line(36, y, model.width - 36, y, '#c7d5e3', 0.7);
    line(76, 40, 76, model.height - 28, '#edbdc3', 0.7);
  } else if (model.paper === 'graph') {
    for (let x = 0; x < model.width; x += 20) line(x, 0, x, model.height, x % 100 ? '#c7d5e3' : '#a8bfd6', x % 100 ? 0.7 : 0.9);
    for (let y = 0; y < model.height; y += 20) line(0, y, model.width, y, y % 100 ? '#c7d5e3' : '#a8bfd6', y % 100 ? 0.7 : 0.9);
  } else if (model.paper === 'dot') {
    const dots = new mu.Path();
    try {
      for (let x = 20; x < model.width; x += 20) for (let y = 20; y < model.height; y += 20) circle(dots, x, y, 0.9);
      device.fillPath(dots, false, mu.Matrix.identity, mu.ColorSpace.DeviceRGB, parseColor('#b5c4d3'), 1);
    } finally { dots.destroy(); }
  }
}

function drawVectorItem(mu: Engine, device: MuPDF.Device, fonts: FontSet, item: InkItem) {
  if (item.type === 'text') {
    item.text.split(/\r?\n/).forEach((line, index) => drawText(mu, device, fonts, line, item.x, item.y + item.fontSize * 0.85 + index * item.fontSize * 1.35, item.fontSize, parseColor(item.color)));
    return;
  }
  if (item.type === 'image') {
    // Browser-only image formats are normalized by exportPdf before reaching here.
    const image = new mu.Image(base64ToBytes(item.dataUrl.slice(item.dataUrl.indexOf(',') + 1)));
    try { device.fillImage(image, [item.w, 0, 0, item.h, item.x, item.y], 1); }
    finally { image.destroy(); }
    return;
  }
  const path = new mu.Path();
  try {
    if (item.type === 'stroke') {
      for (let i = 0; i < item.points.length; i++) {
        const point = item.points[i];
        const radius = strokeRadius(item, point);
        circle(path, point.x, point.y, radius);
        if (i === 0) continue;
        const previous = item.points[i - 1];
        const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
        if (distance === 0) continue;
        const nx = -(point.y - previous.y) / distance, ny = (point.x - previous.x) / distance;
        const previousRadius = strokeRadius(item, previous);
        path.moveTo(previous.x + nx * previousRadius, previous.y + ny * previousRadius);
        path.lineTo(previous.x - nx * previousRadius, previous.y - ny * previousRadius);
        path.lineTo(point.x - nx * radius, point.y - ny * radius);
        path.lineTo(point.x + nx * radius, point.y + ny * radius);
        path.closePath();
      }
      device.fillPath(path, false, mu.Matrix.identity, mu.ColorSpace.DeviceRGB, parseColor(item.color), item.tool === 'highlighter' ? 0.3 : 1);
    } else {
      if (item.shape === 'rectangle') path.rect(Math.min(item.x, item.x + item.w), Math.min(item.y, item.y + item.h), Math.max(item.x, item.x + item.w), Math.max(item.y, item.y + item.h));
      else if (item.shape === 'ellipse') {
        const cx = item.x + item.w / 2, cy = item.y + item.h / 2, rx = Math.abs(item.w / 2), ry = Math.abs(item.h / 2), k = 0.5522847498;
        path.moveTo(cx + rx, cy);
        path.curveTo(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry);
        path.curveTo(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy);
        path.curveTo(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry);
        path.curveTo(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy); path.closePath();
      } else {
        path.moveTo(item.x, item.y); path.lineTo(item.x + item.w, item.y + item.h);
        if (item.shape === 'arrow' && Math.hypot(item.w, item.h) >= 0.001) {
          const angle = Math.atan2(item.h, item.w), length = Math.min(Math.max(12, item.width * 4), Math.hypot(item.w, item.h) * 0.45);
          path.moveTo(item.x + item.w - length * Math.cos(angle - Math.PI / 6), item.y + item.h - length * Math.sin(angle - Math.PI / 6));
          path.lineTo(item.x + item.w, item.y + item.h);
          path.lineTo(item.x + item.w - length * Math.cos(angle + Math.PI / 6), item.y + item.h - length * Math.sin(angle + Math.PI / 6));
        }
      }
      strokePath(mu, device, path, item.color, item.width);
    }
  } finally { path.destroy(); }
}

async function normalizePdfImage(item: ImageItem): Promise<ImageItem> {
  if (/^data:image\/(png|jpe?g|bmp);base64,/i.test(item.dataUrl)) return item;
  if (typeof globalThis.document === 'undefined') throw new Error('This image format needs browser decoding. Convert the image to PNG or JPEG before exporting it.');
  const image = new globalThis.Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('An inserted image could not be decoded for PDF export.'));
    image.src = item.dataUrl;
  });
  const canvas = globalThis.document.createElement('canvas');
  const scale = Math.min(1, 8192 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('An inserted image could not be prepared for PDF export.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { ...item, dataUrl: canvas.toDataURL('image/png') };
}

export async function exportPdf(document: DocumentModel): Promise<Uint8Array> {
  const mu = await engine();
  const output = new mu.PDFDocument();
  const sources = new Map<string, MuPDF.PDFDocument>();
  const fonts = new FontSet(mu);
  try {
    output.setMetaData('info:Title', document.title);
    output.setMetaData('info:Creator', 'Clawdenote');
    for (const model of document.pages) {
      if (model.pdf) {
        let source = sources.get(model.pdf.sourceId);
        if (!source) {
          source = openPdf(mu, sourceBytes(document, model));
          sources.set(model.pdf.sourceId, source);
          source.bake(true, true);
        }
        output.graftPage(-1, source, model.pdf.pageIndex);
      } else {
        const object = output.addPage([0, 0, model.width / PX_PER_POINT, model.height / PX_PER_POINT], 0, null, '');
        try { output.insertPage(-1, object); } finally { object.destroy(); }
      }
      const page = output.loadPage(output.countPages() - 1);
      try {
        if (model.pdf && model.items.length === 0) continue;
        const bounds = page.getBounds();
        const list = new mu.DisplayList([0, 0, model.width, model.height]);
        const device = new mu.DisplayListDevice(list);
        try {
          if (!model.pdf) drawVectorPaper(mu, device, model);
          for (const item of model.items) drawVectorItem(mu, device, fonts, item.type === 'image' ? await normalizePdfImage(item) : item);
          device.close();
          const annotation = page.createAnnotation('Stamp');
          try {
            annotation.setRect(bounds);
            annotation.setAppearanceFromDisplayList('N', null, [
              (bounds[2] - bounds[0]) / model.width, 0, 0, (bounds[3] - bounds[1]) / model.height, bounds[0], bounds[1],
            ], list);
          } finally { annotation.destroy(); }
        } finally { device.destroy(); list.destroy(); }
      } finally { page.destroy(); }
    }
    output.bake(true, true);
    return saveBytes(output);
  } finally {
    fonts.destroy();
    for (const source of sources.values()) source.destroy();
    output.destroy();
  }
}

export async function exportPageImage(document: DocumentModel, model: PageModel, format: 'png' | 'jpeg', scale = 2): Promise<Uint8Array> {
  const background = await renderPdfBackground(document, model, scale);
  await preloadImages(model.items);
  const safeScale = Math.min(Math.max(scale, 0.1), 8192 / Math.max(model.width, model.height));
  const canvas = renderPage(model, background ?? undefined, safeScale);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The page image could not be exported.')), `image/${format}`, 0.95));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportPageSvg(document: DocumentModel, model: PageModel): Promise<string> {
  const background = await renderPdfBackground(document, model, 2);
  return pageToSvg(model, background?.toDataURL('image/png'));
}
