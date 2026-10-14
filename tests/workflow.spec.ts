import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import type { DocumentModel } from '../src/model';

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
