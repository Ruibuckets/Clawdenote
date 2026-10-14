import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import type { DocumentModel, StrokeItem } from '../src/model';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let application: ElectronApplication;
let window: Page;
let temporaryDirectory: string;
let pageErrors: string[];

test.beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'clawdenote-workflow-'));
  pageErrors = [];
  await launchApplication();
});

async function launchApplication() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  environment.INKSTONE_USER_DATA = path.join(temporaryDirectory, 'user-data');
  environment.CLAWDENOTE_USER_DATA = environment.INKSTONE_USER_DATA;
  delete environment.ELECTRON_RUN_AS_NODE;
  const packagedExecutable = process.env.INKSTONE_TEST_EXECUTABLE;
  application = await _electron.launch({
    executablePath: packagedExecutable || require('electron') as string,
    args: packagedExecutable ? [] : ['.'],
    cwd: projectRoot,
    env: environment,
  });
  window = await application.firstWindow();
  window.on('pageerror', error => pageErrors.push(error.message));
  await expect(window.getByTestId('drawing-surface')).toBeVisible();
  await expect(window).toHaveTitle(/^Clawdenote/);
}

test.afterEach(async () => {
  if (application) {
    // Close the test process without a save prompt; all files are temporary.
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
  const target = path.resolve(temporaryDirectory);
  if (path.dirname(target) === path.resolve(tmpdir()) && path.basename(target).startsWith('clawdenote-workflow-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function chooseFiles(files: { open?: string; save?: string }) {
  await application.evaluate(({ dialog }, chosen) => {
    if (chosen.open) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen.open!] });
    if (chosen.save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen.save! });
  }, files);
}

async function saveNotebook(name = 'notebook.clawdenote', saveAs = false): Promise<DocumentModel> {
  const destination = path.join(temporaryDirectory, name);
  const previousModified = await stat(destination).then(file => file.mtimeMs).catch(() => 0);
  await chooseFiles({ save: destination });
  await window.getByRole('button', { name: saveAs ? 'Save a copy…' : 'Save notebook', exact: true }).click();
  await expect.poll(async () => {
    try { return (await stat(destination)).mtimeMs; } catch { return 0; }
  }).toBeGreaterThan(previousModified);
  return JSON.parse(await readFile(destination, 'utf8')) as DocumentModel;
}

async function dragOnPage(from = { x: 100, y: 180 }, to = { x: 260, y: 220 }) {
  const surface = window.getByTestId('drawing-surface');
  await surface.scrollIntoViewIfNeeded();
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('Drawing surface has no bounds');
  // Points are in the model's A4 coordinate system, independent of zoom.
  const scale = bounds.width / 794;
  await window.mouse.move(bounds.x + from.x * scale, bounds.y + from.y * scale);
  await window.mouse.down();
  await window.mouse.move(bounds.x + to.x * scale, bounds.y + to.y * scale, { steps: 16 });
  await window.mouse.up();
}

async function exportTo(format: string, filename: string) {
  const destination = path.join(temporaryDirectory, filename);
  await chooseFiles({ save: destination });
  await window.getByRole('button', { name: 'Export', exact: true }).click();
  await window.getByLabel('Export format', { exact: true }).selectOption(format);
  await window.getByRole('button', { name: 'Export file', exact: true }).click();
  let lastStatus = '';
  try {
    await expect.poll(async () => {
      const statuses = await window.getByRole('status').allTextContents();
      if (statuses.length) lastStatus = statuses.join(' | ');
      try { return (await stat(destination)).size; } catch { return 0; }
    }, { timeout: 30_000 }).toBeGreaterThan(20);
  } catch (error) {
    throw new Error(`Export ${format} did not produce ${filename}. Last app status: ${lastStatus}`, { cause: error });
  }
  return destination;
}

function extractPdfText(bytes: Uint8Array): { count: number; text: string } {
  const document = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const count = document.countPages();
    const texts: string[] = [];
    for (let index = 0; index < count; index++) {
      const page = document.loadPage(index);
      const text = page.toStructuredText('');
      try { texts.push(text.asText()); } finally { text.destroy(); page.destroy(); }
    }
    return { count, text: texts.join('\n') };
  } finally { document.destroy(); }
}

test('drawing, erasing, page operations, native save/reopen, and exports preserve the notebook', async ({}, testInfo) => {
  await window.getByRole('button', { name: 'Graph paper', exact: true }).click();
  await window.getByRole('button', { name: 'Pen', exact: true }).click();
  await dragOnPage();
  const drawn = await saveNotebook();
  expect(drawn.pages[0].paper).toBe('graph');
  expect(drawn.pages[0].items).toHaveLength(1);
  expect(drawn.pages[0].items[0].type).toBe('stroke');

  await window.getByRole('button', { name: 'Eraser', exact: true }).click();
  await dragOnPage();
  const erased = await saveNotebook();
  expect(erased.pages[0].items).toHaveLength(0);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await window.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await dragOnPage({ x: 330, y: 180 }, { x: 470, y: 280 });
  await window.getByRole('button', { name: 'Duplicate page', exact: true }).click();
  await window.getByRole('button', { name: 'Add page', exact: true }).click();
  await window.getByRole('button', { name: 'Lined paper', exact: true }).click();
  const complete = await saveNotebook();
  expect(complete.pages).toHaveLength(3);
  expect(complete.pages[0].items.map(item => item.type)).toEqual(['stroke', 'shape']);
  expect(complete.pages[1].items).toHaveLength(2);
  expect(complete.pages[1].id).not.toBe(complete.pages[0].id);
  expect(complete.pages[2].paper).toBe('lined');
  await window.getByRole('button', { name: 'Page 1', exact: true }).click();
  const dismissNotification = window.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismissNotification.isVisible()) await dismissNotification.click();
  await window.getByRole('button', { name: 'Fit page', exact: true }).click();
  await window.screenshot({ path: testInfo.outputPath('Clawdenote-notebook.png') });

  await chooseFiles({ open: path.join(temporaryDirectory, 'notebook.clawdenote') });
  await window.getByRole('button', { name: 'Open', exact: true }).click();
  const reopened = await saveNotebook();
  expect(reopened.pages).toEqual(complete.pages);

  const pdf = await exportTo('pdf', 'notebook.pdf');
  expect(extractPdfText(new Uint8Array(await readFile(pdf))).count).toBe(3);
  const png = await exportTo('png', 'page.png');
  expect((await readFile(png)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = await exportTo('jpeg', 'page.jpg');
  expect((await readFile(jpg)).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  const svg = await exportTo('svg', 'page.svg');
  expect(await readFile(svg, 'utf8')).toContain('<svg');
  const legacyPath = path.join(temporaryDirectory, 'legacy.inkstone');
  await writeFile(legacyPath, JSON.stringify(complete));
  await chooseFiles({ open: legacyPath });
  await window.getByRole('button', { name: 'Open', exact: true }).click();
  const migrated = await saveNotebook('legacy-migrated.clawdenote', true);
  expect(migrated.pages).toEqual(complete.pages);
  expect(pageErrors).toEqual([]);
});

test('existing PDF text is replaced in the exported document and survives notebook save', async () => {
  const fixture = await PDFDocument.create();
  const font = await fixture.embedFont(StandardFonts.Helvetica);
  const page = fixture.addPage([595.28, 841.89]);
  page.drawText('Original PDF text', { x: 72, y: 740, size: 18, font });
  page.drawText('Keep this text', { x: 72, y: 670, size: 16, font });
  const fixturePath = path.join(temporaryDirectory, 'original.pdf');
  await writeFile(fixturePath, await fixture.save());
  await chooseFiles({ open: fixturePath });
  await window.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(window.getByText('PDF WORKSPACE', { exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Edit PDF text', exact: true }).click();
  await expect(window.locator('.pdf-text-block')).toHaveCount(2);
  // The PDF text is at 72 pt from the left and about 102 pt from the top.
  const bounds = await window.getByTestId('drawing-surface').boundingBox();
  if (!bounds) throw new Error('PDF drawing surface has no bounds');
  await window.mouse.click(bounds.x + 105 / 595.28 * bounds.width, bounds.y + 97 / 595.28 * bounds.width);
  await window.getByLabel('Replacement text', { exact: true }).fill('Revised PDF text');
  await window.getByRole('button', { name: 'Apply replacement', exact: true }).click();
  await expect(window.getByLabel('Replacement text', { exact: true })).not.toBeVisible();
  const notebook = await saveNotebook('pdf-notebook.clawdenote');
  expect(notebook.pages[0].pdf).toBeDefined();
  const embedded = notebook.pdfSources[notebook.pages[0].pdf!.sourceId];
  const savedText = extractPdfText(new Uint8Array(Buffer.from(embedded, 'base64'))).text;
  expect(savedText).toContain('Revised PDF text');
  expect(savedText).not.toContain('Original PDF text');
  expect(savedText).toContain('Keep this text');
  const exportPath = await exportTo('pdf', 'revised.pdf');
  const exported = extractPdfText(new Uint8Array(await readFile(exportPath)));
  expect(exported.count).toBe(1);
  expect(exported.text).toContain('Revised PDF text');
  expect(exported.text).not.toContain('Original PDF text');
  expect(exported.text).toContain('Keep this text');
  expect(pageErrors).toEqual([]);
});

test('recovery survives interruption, delayed restore, and closing the unresolved recovery prompt', async () => {
  await window.getByLabel('Notebook name', { exact: true }).fill('Recovery check');
  await window.getByRole('button', { name: 'Graph paper', exact: true }).click();
  await dragOnPage();
  const recoveryFile = path.join(temporaryDirectory, 'user-data', 'recovery.inkstone');
  await expect.poll(async () => {
    try { return (JSON.parse(await readFile(recoveryFile, 'utf8')) as DocumentModel).pages[0].items.length; }
    catch { return 0; }
  }).toBe(1);
  const recovered = JSON.parse(await readFile(recoveryFile, 'utf8')) as DocumentModel;
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await application.close().catch(() => {});
  await launchApplication();
  await expect(window.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  // Wait beyond the 900 ms autosave delay to detect startup overwrites.
  await window.waitForTimeout(1_200);
  expect((JSON.parse(await readFile(recoveryFile, 'utf8')) as DocumentModel).id).toBe(recovered.id);
  const closed = application.waitForEvent('close', { timeout: 15_000 });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  await closed;
  await application.close().catch(() => {});
  expect((JSON.parse(await readFile(recoveryFile, 'utf8')) as DocumentModel).id).toBe(recovered.id);
  await launchApplication();
  await expect(window.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Restore', exact: true }).click();
  const restored = await saveNotebook('restored.clawdenote');
  expect(restored.id).toBe(recovered.id);
  expect(restored.title).toBe('Recovery check');
  expect(restored.pages[0].paper).toBe('graph');
  expect(restored.pages[0].items).toEqual(recovered.pages[0].items);
  expect(pageErrors).toEqual([]);
});

test('ink smoothing reduces visible jitter, survives export, and preserves pen lift endpoints', async ({}, testInfo) => {
  type SmoothedStroke = StrokeItem & { smoothing?: number };
  const smoothing = window.getByRole('slider', { name: 'Ink smoothing', exact: true });
  await expect(smoothing).toHaveValue('55');
  const samples = Array.from({ length: 61 }, (_, index) => ({
    x: 90 + index * 8,
    y: 230 + Math.sin(index * 0.17) * 32 + (index % 2 === 0 ? 5 : -5),
  }));
  async function mouseSamples(yOffset = 0) {
    const bounds = await window.getByTestId('drawing-surface').boundingBox();
    if (!bounds) throw new Error('Writing surface has no bounds');
    const scale = bounds.width / 794;
    await window.mouse.move(bounds.x + samples[0].x * scale, bounds.y + (samples[0].y + yOffset) * scale);
    await window.mouse.down();
    await window.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const paintsBefore = await window.evaluate(() => ({ ...(globalThis as typeof globalThis & { inkTestPaints: { committed: number; live: number } }).inkTestPaints }));
    for (const sample of samples.slice(1)) {
      await window.mouse.move(bounds.x + sample.x * scale, bounds.y + (sample.y + yOffset) * scale);
    }
    await window.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const paintsAfter = await window.evaluate(() => ({ ...(globalThis as typeof globalThis & { inkTestPaints: { committed: number; live: number } }).inkTestPaints }));
    expect(paintsAfter.committed).toBe(paintsBefore.committed);
    expect(paintsAfter.live).toBeGreaterThan(paintsBefore.live);
    await window.mouse.up();
  }
  await window.evaluate(() => {
    const paints = { committed: 0, live: 0 };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<typeof clear>) {
      if (this.canvas.classList.contains('committed-ink')) paints.committed++;
      if (this.canvas.classList.contains('ink-canvas')) paints.live++;
      return clear.apply(this, args);
    };
    Object.assign(globalThis, { inkTestPaints: paints });
    const durations: number[] = [];
    const observer = new PerformanceObserver(list => durations.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ entryTypes: ['longtask'] });
    Object.assign(globalThis, { inkTestPerformance: { durations, observer, started: performance.now() } });
  });
  await smoothing.focus();
  await smoothing.press('Home');
  await expect(smoothing).toHaveValue('0');
  await mouseSamples();
  await smoothing.focus();
  await smoothing.press('End');
  await expect(smoothing).toHaveValue('100');
  await mouseSamples(170);

  // Trusted Chromium pen events exercise pressure and capture, without claiming hardware coverage.
  await window.getByLabel('Pen only / palm rejection', { exact: true }).check();
  const bounds = await window.getByTestId('drawing-surface').boundingBox();
  if (!bounds) throw new Error('Writing surface has no bounds');
  const scale = bounds.width / 794;
  const pen = await window.context().newCDPSession(window);
  const position = (x: number, y: number) => ({ x: bounds.x + x * scale, y: bounds.y + y * scale });
  await pen.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position(90, 600), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.2 });
  await pen.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position(190, 610), button: 'left', buttons: 1, pointerType: 'pen', force: 0.8 });
  await pen.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position(260, 610), button: 'left', buttons: 1, pointerType: 'pen', force: 0.65 });
  await pen.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position(300, 620), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
  await pen.detach();
  await window.getByLabel('Pen only / palm rejection', { exact: true }).uncheck();
  const captured = await saveNotebook();
  const strokes = captured.pages[0].items.filter((item): item is SmoothedStroke => item.type === 'stroke');
  expect(strokes).toHaveLength(3);
  expect(strokes[0].smoothing).toBe(0);
  expect(strokes[1].smoothing).toBe(1);
  expect(strokes[0].points.at(-1)!.x).toBeCloseTo(samples.at(-1)!.x, 0);
  expect(strokes[1].points.at(-1)!.x).toBeCloseTo(samples.at(-1)!.x, 0);
  expect(strokes[2].points.at(-1)!.x).toBeCloseTo(300, 0);
  expect(strokes[2].points.at(-1)!.y).toBeCloseTo(620, 0);
  expect(strokes[2].points.at(-1)!.pressure).toBeCloseTo(0.65, 2);
  expect(strokes[2].points[0].pressure).toBeCloseTo(0.2, 2);
  const performanceSample = await window.evaluate(() => {
    const recorded = (globalThis as typeof globalThis & {
      inkTestPerformance: { durations: number[]; observer: PerformanceObserver; started: number };
    }).inkTestPerformance;
    recorded.observer.disconnect();
    return { elapsedMs: performance.now() - recorded.started, longTaskCount: recorded.durations.length, maximumLongTaskMs: Math.max(0, ...recorded.durations) };
  });
  await testInfo.attach('live-ink-performance.json', { body: JSON.stringify(performanceSample, null, 2), contentType: 'application/json' });

  // Exact shared input samples make the visual comparison independent of event timing.
  const comparison = structuredClone(captured);
  const original = { ...strokes[0], width: 5, smoothing: 0 };
  comparison.title = 'Ink smoothing comparison';
  comparison.pages[0].items = [
    { id: 'rough-label', type: 'text', x: 90, y: 155, text: 'Smoothing off — original pen samples', color: '#27352f', fontSize: 21 },
    original,
    { id: 'smooth-label', type: 'text', x: 90, y: 325, text: 'Smoothing 55% — same pen samples', color: '#27352f', fontSize: 21 },
    { ...original, id: 'smoothed-comparison', smoothing: 0.55, points: original.points.map(point => ({ ...point, y: point.y + 170 })) },
  ];
  const comparisonFile = path.join(temporaryDirectory, 'comparison.clawdenote');
  await writeFile(comparisonFile, JSON.stringify(comparison));
  await chooseFiles({ open: comparisonFile });
  await window.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(window.getByLabel('Notebook name', { exact: true })).toHaveValue(comparison.title);
  const reopened = await saveNotebook('comparison.clawdenote');
  expect(reopened.pages[0].items).toEqual(comparison.pages[0].items);

  async function jitterMetrics(pngBase64?: string) {
    return window.evaluate(async ({ imageData }) => {
      let canvas: HTMLCanvasElement;
      if (imageData) {
        const image = new Image();
        image.src = 'data:image/png;base64,' + imageData;
        await image.decode();
        canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
      } else {
        canvas = document.querySelector<HTMLCanvasElement>('canvas.committed-ink')!;
      }
      if (!canvas) throw new Error('Committed ink canvas is unavailable');
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const pixelScale = canvas.width / 794;
      function rowJitter(offset: number) {
        const centers: number[] = [];
        for (let modelX = 114; modelX < 546; modelX += 3) {
          const x = Math.round(modelX * pixelScale);
          let weight = 0, weightedY = 0;
          for (let y = Math.floor((190 + offset) * pixelScale); y < Math.ceil((270 + offset) * pixelScale); y++) {
            const index = (y * canvas.width + x) * 4;
            const ink = pixels[index + 3] / 255 * (1 - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) / 255);
            if (ink > 0.02) { weight += ink; weightedY += y / pixelScale * ink; }
          }
          if (weight) centers.push(weightedY / weight);
        }
        const differences = centers.slice(2).map((value, index) => Math.abs(value - 2 * centers[index + 1] + centers[index]));
        return { columns: centers.length, jitter: differences.reduce((sum, value) => sum + value, 0) / differences.length };
      }
      return { rough: rowJitter(0), smooth: rowJitter(170) };
    }, { imageData: pngBase64 });
  }
  await expect.poll(async () => (await jitterMetrics()).smooth.columns).toBeGreaterThan(100);
  const canvasMetrics = await jitterMetrics();
  await testInfo.attach('smoothing-canvas-metrics.json', { body: JSON.stringify(canvasMetrics, null, 2), contentType: 'application/json' });
  expect(canvasMetrics.smooth.jitter).toBeLessThan(canvasMetrics.rough.jitter * 0.75);
  const png = await exportTo('png', 'smoothing.png');
  const exportMetrics = await jitterMetrics((await readFile(png)).toString('base64'));
  expect(exportMetrics.smooth.jitter).toBeLessThan(exportMetrics.rough.jitter * 0.75);
  const svg = await exportTo('svg', 'smoothing.svg');
  expect((await readFile(svg, 'utf8')).match(/<path\b/g)?.length).toBeGreaterThanOrEqual(2);
  const pdf = await exportTo('pdf', 'smoothing.pdf');
  const pdfDocument = mupdf.Document.openDocument(new Uint8Array(await readFile(pdf)), 'application/pdf');
  let pdfPng: Uint8Array;
  try {
    const pdfPage = pdfDocument.loadPage(0);
    try {
      const pixmap = pdfPage.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
      try { pdfPng = new Uint8Array(pixmap.asPNG()); } finally { pixmap.destroy(); }
    } finally { pdfPage.destroy(); }
  } finally { pdfDocument.destroy(); }
  const pdfMetrics = await jitterMetrics(Buffer.from(pdfPng!).toString('base64'));
  expect(pdfMetrics.smooth.jitter).toBeLessThan(pdfMetrics.rough.jitter * 0.75);
  await testInfo.attach('ink-jitter-comparison.json', { body: JSON.stringify({ canvasMetrics, exportMetrics, pdfMetrics }, null, 2), contentType: 'application/json' });
  await smoothing.focus();
  await smoothing.press('Home');
  for (let value = 0; value < 55; value += 5) await smoothing.press('ArrowRight');
  await expect(smoothing).toHaveValue('55');
  const dismissNotification = window.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismissNotification.isVisible()) await dismissNotification.click();
  await window.getByRole('button', { name: 'Fit page', exact: true }).click();
  await window.screenshot({ path: testInfo.outputPath('Clawdenote-smoothing-comparison.png') });
  await window.getByRole('button', { name: 'Select & move', exact: true }).click();
  const selectedBounds = await window.getByTestId('drawing-surface').boundingBox();
  if (!selectedBounds) throw new Error('Writing surface has no bounds');
  const selectedScale = selectedBounds.width / 794;
  const pickedPoint = original.points[20];
  await window.mouse.click(selectedBounds.x + pickedPoint.x * selectedScale, selectedBounds.y + pickedPoint.y * selectedScale);
  await expect(smoothing).toHaveValue('0');
  await smoothing.focus();
  await smoothing.press('End');
  const adjusted = await saveNotebook('comparison.clawdenote');
  const adjustedStroke = adjusted.pages[0].items.find(item => item.id === original.id) as SmoothedStroke;
  expect(adjustedStroke.smoothing).toBe(1);
  expect(adjustedStroke.points).toEqual(original.points);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await saveNotebook('comparison.clawdenote');
  expect((undone.pages[0].items.find(item => item.id === original.id) as SmoothedStroke).smoothing).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('images finishing decode repaint the cached page while writing', async () => {
  const fixture = await saveNotebook();
  const imageUrl = await window.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20; canvas.height = 20;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 20, 20);
    const NativeImage = window.Image;
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete')!.get!;
    const gate = { open: false, pending: [] as (() => void)[] };
    window.Image = function (width?: number, height?: number) {
      const image = new NativeImage(width, height);
      let loaded: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
      Object.defineProperty(image, 'complete', { get: () => gate.open && complete.call(image) });
      Object.defineProperty(image, 'onload', { get: () => loaded, set: (handler: typeof loaded) => { loaded = handler; } });
      image.addEventListener('load', event => {
        const deliver = () => loaded?.call(image, event);
        if (gate.open) deliver(); else gate.pending.push(deliver);
      });
      return image;
    } as unknown as typeof Image;
    Object.assign(globalThis, { inkImageGate: gate, releaseInkImages: () => { gate.open = true; gate.pending.splice(0).forEach(deliver => deliver()); } });
    return canvas.toDataURL();
  });
  fixture.pages[0].items = [{ id: 'delayed-image', type: 'image', dataUrl: imageUrl, x: 90, y: 180, w: 160, h: 100 }];
  const filename = path.join(temporaryDirectory, 'delayed-image.clawdenote');
  await writeFile(filename, JSON.stringify(fixture));
  await chooseFiles({ open: filename });
  await window.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => window.evaluate(() => (globalThis as typeof globalThis & { inkImageGate: { pending: unknown[] } }).inkImageGate.pending.length)).toBeGreaterThan(0);
  const bounds = await window.getByTestId('drawing-surface').boundingBox();
  if (!bounds) throw new Error('Writing surface has no bounds');
  const scale = bounds.width / 794;
  await window.mouse.move(bounds.x + 320 * scale, bounds.y + 210 * scale);
  await window.mouse.down();
  const imagePixel = () => window.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.committed-ink')!;
    const scale = canvas.width / 794;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.round(160 * scale), Math.round(220 * scale), 1, 1).data);
  });
  expect((await imagePixel())[3]).toBe(0);
  await window.evaluate(() => (globalThis as typeof globalThis & { releaseInkImages: () => void }).releaseInkImages());
  await expect.poll(imagePixel).toEqual([255, 0, 0, 255]);
  await window.mouse.up();
  expect(pageErrors).toEqual([]);
});
