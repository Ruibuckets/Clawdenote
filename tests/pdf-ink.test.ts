import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { drawItem, itemsToSvg } from '../src/drawing';
import { exportPdf, importPdf } from '../src/pdf';
import { createDocument } from '../src/model';
import type { DocumentModel, StrokeItem } from '../src/model';
import type { InkPathCommand } from '../src/ink';

const stroke: StrokeItem = {
  id: 'smooth-ink', type: 'stroke', tool: 'pen', color: '#27352f', width: 6, smoothing: 0.8,
  points: Array.from({ length: 60 }, (_, index) => ({
    x: 40 + index * 4.7,
    y: 185 + Math.sin(index / 6) * 25 + (index % 2 ? 2.8 : -2.8),
    pressure: 0.45 + Math.sin(index / 9) * 0.3,
  })),
};

/** Capture the public canvas renderer's path, independently of the PDF backend. */
function captureCanvasPath(item: StrokeItem): { commands: InkPathCommand[]; alpha: number } {
  const commands: InkPathCommand[] = [];
  let alpha = 1;
  const context = {
    globalAlpha: 1, fillStyle: '', save() {}, restore() {}, beginPath() {},
    moveTo(x: number, y: number) { commands.push({ type: 'move', x, y }); },
    lineTo(x: number, y: number) { commands.push({ type: 'line', x, y }); },
    bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
      commands.push({ type: 'cubic', x1, y1, x2, y2, x, y });
    },
    closePath() { commands.push({ type: 'close' }); },
    fill(rule: string) { expect(rule).toBe('nonzero'); alpha = this.globalAlpha; },
  };
  drawItem(context as unknown as CanvasRenderingContext2D, item);
  return { commands, alpha };
}

function parseSvgPath(svg: string): InkPathCommand[] {
  const data = /<path\b[^>]*\bd="([^"]+)"/.exec(svg)?.[1];
  if (!data) throw new Error('SVG export did not contain an ink path.');
  const tokens = data.match(/[MCLZ]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi)!;
  const commands: InkPathCommand[] = [];
  let offset = 0;
  const value = () => Number(tokens[offset++]);
  while (offset < tokens.length) {
    const kind = tokens[offset++].toUpperCase();
    if (kind === 'M') commands.push({ type: 'move', x: value(), y: value() });
    else if (kind === 'L') commands.push({ type: 'line', x: value(), y: value() });
    else if (kind === 'C') commands.push({ type: 'cubic', x1: value(), y1: value(), x2: value(), y2: value(), x: value(), y: value() });
    else if (kind === 'Z') commands.push({ type: 'close' });
    else throw new Error(`Unexpected SVG path command ${kind}.`);
  }
  return commands;
}

function rasterizePath(commands: InkPathCommand[], alpha: number): Uint8ClampedArray {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 400, 400], false);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  const path = new mupdf.Path();
  try {
    pixmap.clear(255);
    for (const command of commands) {
      if (command.type === 'move') path.moveTo(command.x, command.y);
      else if (command.type === 'line') path.lineTo(command.x, command.y);
      else if (command.type === 'cubic') path.curveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
      else path.closePath();
    }
    device.fillPath(path, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [39 / 255, 53 / 255, 47 / 255], alpha);
    device.close();
    return pixmap.getPixels().slice();
  } finally { path.destroy(); device.destroy(); pixmap.destroy(); }
}

function rasterizePdf(bytes: Uint8Array): Uint8ClampedArray {
  const document = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = document.loadPage(0);
  let pixmap: mupdf.Pixmap | undefined;
  try {
    const bounds = page.getBounds();
    pixmap = page.toPixmap(mupdf.Matrix.scale(400 / (bounds[2] - bounds[0]), 400 / (bounds[3] - bounds[1])), mupdf.ColorSpace.DeviceRGB, false);
    expect([pixmap.getWidth(), pixmap.getHeight()]).toEqual([400, 400]);
    return pixmap.getPixels().slice();
  } finally { pixmap?.destroy(); page.destroy(); document.destroy(); }
}

function meanPixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  expect(left.length).toBe(right.length);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference += Math.abs(left[index] - right[index]);
  return difference / left.length;
}

function notebook(item: StrokeItem): DocumentModel {
  const document = createDocument('Smooth ink regression');
  Object.assign(document.pages[0], { width: 400, height: 400, items: [item] });
  return document;
}

describe('smooth ink survives PDF export', () => {
  it.each(['pen', 'highlighter'] as const)('renders the same %s outline as Canvas and SVG', async tool => {
    const item: StrokeItem = { ...stroke, tool, width: tool === 'highlighter' ? 18 : stroke.width };
    const canvas = captureCanvasPath(item);
    const expected = rasterizePath(canvas.commands, canvas.alpha);
    const svg = rasterizePath(parseSvgPath(itemsToSvg([item])), canvas.alpha);
    const exported = rasterizePdf(await exportPdf(notebook(item)));
    // The SVG rounds coordinates and PDF applies a points-to-pixels transform.
    // A tiny raster tolerance allows antialias rounding while catching rough outlines.
    expect(meanPixelDifference(expected, svg)).toBeLessThan(0.05);
    expect(meanPixelDifference(expected, exported)).toBeLessThan(0.05);
    const roughCanvas = captureCanvasPath({ ...item, smoothing: 0 });
    const rough = rasterizePath(roughCanvas.commands, roughCanvas.alpha);
    expect(meanPixelDifference(expected, rough)).toBeGreaterThan(0.15);
  });

  it('keeps original PDF typed text searchable beneath smoothed ink annotations', async () => {
    const original = new mupdf.PDFDocument();
    const font = new mupdf.Font('Helvetica');
    const fontObject = original.addSimpleFont(font);
    const pageObject = original.addPage([0, 0, 300, 300], 0, { Font: { F1: fontObject } }, 'BT /F1 12 Tf 20 250 Td (Original searchable text) Tj ET');
    let buffer: mupdf.Buffer | undefined;
    try {
      original.insertPage(-1, pageObject);
      buffer = original.saveToBuffer('compress');
      const imported = await importPdf(buffer.asUint8Array().slice(), 'Text fixture.pdf');
      const document = createDocument('Annotated PDF');
      document.pages = imported.pages;
      document.pdfSources = { [imported.sourceId]: imported.sourceData };
      document.pages[0].items = [stroke];
      const output = mupdf.Document.openDocument(await exportPdf(document), 'application/pdf');
      const page = output.loadPage(0);
      const structured = page.toStructuredText('');
      try {
        expect(output.countPages()).toBe(1);
        expect(structured.asText()).toContain('Original searchable text');
      } finally { structured.destroy(); page.destroy(); output.destroy(); }
    } finally { buffer?.destroy(); pageObject.destroy(); fontObject.destroy(); font.destroy(); original.destroy(); }
  });
});
