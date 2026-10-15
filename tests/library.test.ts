import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDocument } from '../src/model';
import type { LibraryEntry, LibraryImportResult, LibraryReadResult } from '../src/library';

interface Backend {
  list(includeDeleted?: boolean): Promise<LibraryEntry[]>;
  read(id: string): Promise<LibraryReadResult>;
  save(id: string | null, data: string, preview?: string): Promise<LibraryEntry>;
  import(data: string, sourcePath?: string): Promise<LibraryImportResult>;
  delete(id: string): Promise<void>;
  restore(id: string): Promise<LibraryEntry>;
}
interface Options { root: string; documentsPath?: string; recoveryPath?: string; now?: () => string }
const { NotebookLibrary } = createRequire(import.meta.url)('../electron/library.cjs') as { NotebookLibrary: new (options: Options) => Backend };
const nodeFs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const temporary: string[] = [];
const testTmp = fileURLToPath(new URL('../tmp/library-tests/', import.meta.url));

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of temporary.splice(0)) {
    if (path.dirname(directory) === path.resolve(testTmp) && path.basename(directory).startsWith('clawdenote-library-')) await rm(directory, { recursive: true, force: true });
  }
});

describe('browser notebook library fallback', () => {
  async function browserFixture() {
    const values = new Map<string, string>();
    let full = false;
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { if (full) throw new Error('Browser storage quota exceeded'); values.set(key, value); },
    });
    vi.resetModules();
    const { desktop } = await import('../src/desktop');
    return { desktop, values, setFull: (value: boolean) => { full = value; } };
  }

  it('preserves independent notes, deduplicates imports, and rejects stale autosave after Trash', async () => {
    const { desktop } = await browserFixture();
    const initial = data('Browser notebook');
    const imported = await desktop.libraryImport(initial);
    const latest = data('Browser latest', '2026-10-14T12:00:00.000Z', JSON.parse(initial).id);
    await desktop.librarySave(imported.entry.id, latest);
    expect((await desktop.libraryImport(initial)).data).toBe(latest);
    await desktop.libraryDelete(imported.entry.id);
    expect(await desktop.libraryList()).toEqual([]);
    await expect(desktop.librarySave(imported.entry.id, initial)).rejects.toThrow('Trash');
    await desktop.libraryRestore(imported.entry.id);
    expect((await desktop.libraryRead(imported.entry.id)).data).toBe(latest);
  });

  it('propagates quota failures and preserves the last durable note', async () => {
    const { desktop, setFull } = await browserFixture();
    const initial = data('Durable browser note');
    const entry = await desktop.librarySave(null, initial);
    setFull(true);
    await expect(desktop.librarySave(entry.id, data('Cannot be written'))).rejects.toThrow('quota');
    setFull(false);
    expect((await desktop.libraryRead(entry.id)).data).toBe(initial);
  });

  it('shows healthy browser notes alongside a corrupt entry without rewriting its stored data', async () => {
    const { desktop, values } = await browserFixture();
    const entry = await desktop.librarySave(null, data('Healthy browser note'));
    const stored = JSON.parse(values.get('clawdenote-library-v1')!);
    const corruptId = crypto.randomUUID();
    stored.notes[corruptId] = null;
    const raw = JSON.stringify(stored);
    values.set('clawdenote-library-v1', raw);
    const listed = await desktop.libraryList();
    expect(listed.find(note => note.id === entry.id)?.title).toBe('Healthy browser note');
    expect(listed.find(note => note.id === corruptId)?.error).toContain('preserved');
    expect(values.get('clawdenote-library-v1')).toBe(raw);
  });
});

async function fixture() {
  await mkdir(testTmp, { recursive: true });
  const directory = await mkdtemp(path.join(testTmp, 'clawdenote-library-'));
  temporary.push(directory);
  const documentsPath = path.join(directory, 'Documents');
  await mkdir(documentsPath);
  const options = { root: path.join(directory, 'library'), documentsPath, recoveryPath: path.join(directory, 'recovery.inkstone') };
  return { directory, documentsPath, options, library: new NotebookLibrary(options) };
}
function data(title: string, updatedAt = '2026-10-14T10:00:00.000Z', id?: string) {
  const document = createDocument(title);
  document.updatedAt = updatedAt;
  if (id) document.id = id;
  return JSON.stringify(document);
}

describe('local notebook library', () => {
  it('persists independent notebooks and orders recent work by save or open time', async () => {
    const { options } = await fixture();
    let clock = '2026-10-14T10:00:00.000Z';
    const library = new NotebookLibrary({ ...options, now: () => clock });
    const first = await library.save(null, data('First'));
    clock = '2026-10-14T11:00:00.000Z';
    const second = await library.save(null, data('Second'));
    expect((await library.list()).map(entry => entry.id)).toEqual([second.id, first.id]);
    clock = '2026-10-14T12:00:00.000Z';
    expect((await library.read(first.id)).entry.lastOpenedAt).toBe(clock);
    expect((await library.list()).map(entry => entry.id)).toEqual([first.id, second.id]);
    const reopened = new NotebookLibrary(options);
    expect(JSON.parse((await reopened.read(second.id)).data).title).toBe('Second');
    expect(await readdir(path.join(options.root, 'notes', first.id))).toEqual(expect.arrayContaining(['document.json', 'metadata.json']));
  });

  it('imports a source once and returns the latest managed copy for paths and document IDs', async () => {
    const { library, documentsPath } = await fixture();
    const original = data('Imported notebook');
    const documentId = JSON.parse(original).id as string;
    const sourcePath = path.join(documentsPath, 'Shared.clawdenote');
    const imported = await library.import(original, sourcePath);
    expect(imported.imported).toBe(true);
    const edited = data('Latest managed edits', '2026-10-14T12:00:00.000Z', documentId);
    await library.save(imported.entry.id, edited);
    const again = await library.import(original, sourcePath);
    expect(again).toMatchObject({ imported: false, data: edited, entry: { id: imported.entry.id } });
    const renamedSource = await library.import(original, path.join(documentsPath, 'Renamed.inkstone'));
    expect(renamedSource.entry.id).toBe(imported.entry.id);
    expect(renamedSource.data).toBe(edited);
    expect(await library.list()).toHaveLength(1);
  });

  it('serializes saves and Trash moves, rejects stale autosave, and restores the durable latest version', async () => {
    const { library } = await fixture();
    const initial = data('Original');
    const entry = await library.save(null, initial);
    const latest = data('Latest before delete', '2026-10-14T12:00:00.000Z', JSON.parse(initial).id);
    const results = await Promise.allSettled([library.save(entry.id, latest), library.delete(entry.id), library.save(entry.id, initial)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(await library.list()).toHaveLength(0);
    expect((await library.list(true))[0]).toMatchObject({ id: entry.id, deletedAt: expect.any(String) });
    await library.restore(entry.id);
    expect((await library.read(entry.id)).data).toBe(latest);
    await library.delete(entry.id);
    const imported = await library.import(initial);
    expect(imported).toMatchObject({ imported: false, data: latest, entry: { id: entry.id } });
    expect(imported.entry.deletedAt).toBeUndefined();
  });

  it('rejects traversal IDs and bounds metadata without preventing large-thumbnail saves', async () => {
    const { library } = await fixture();
    for (const id of ['../outside', '..\\outside', '/absolute', '', 'document.json']) {
      expect(() => library.read(id)).toThrow('Invalid notebook ID');
      expect(() => library.save(id, data('Unsafe'))).toThrow('Invalid notebook ID');
      expect(() => library.delete(id)).toThrow('Invalid notebook ID');
    }
    const entry = await library.save(null, data('Bounded preview'), 'data:image/png;base64,' + 'A'.repeat(400_000));
    expect(entry.previewDataUrl).toBeUndefined();
    expect(() => library.save(entry.id, data('Invalid preview'), '<svg>')).toThrow('preview');
  });

  it('repairs missing metadata and lists healthy notes alongside preserved corrupt documents', async () => {
    const { options, library } = await fixture();
    const first = await library.save(null, data('Metadata repair'));
    const second = await library.save(null, data('Corrupt document'));
    await rm(path.join(options.root, 'notes', first.id, 'metadata.json'));
    await rm(path.join(options.root, 'notes', second.id, 'metadata.json'));
    await writeFile(path.join(options.root, 'notes', second.id, 'document.json'), '{broken JSON');
    const reopened = new NotebookLibrary(options);
    const entries = await reopened.list();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.id === first.id)).toMatchObject({ title: 'Metadata repair', pageCount: 1 });
    expect(entries.find(entry => entry.id === second.id)?.error).toContain('preserved');
    await expect(reopened.read(second.id)).rejects.toThrow();
    expect(await readFile(path.join(options.root, 'notes', second.id, 'document.json'), 'utf8')).toBe('{broken JSON');
    expect(JSON.parse((await reopened.read(first.id)).data).title).toBe('Metadata repair');
  });

  it('migrates only top-level notebooks and the newest meaningful recovery without altering originals', async () => {
    const { directory, documentsPath, options } = await fixture();
    const original = data('Saved title', '2026-10-14T10:00:00.000Z');
    const logicalId = JSON.parse(original).id as string;
    const recovery = data('Recovered latest edits', '2026-10-14T12:00:00.000Z', logicalId);
    const sourcePath = path.join(documentsPath, 'Notebook.clawdenote');
    await writeFile(sourcePath, original);
    await writeFile(options.recoveryPath, recovery);
    await mkdir(path.join(documentsPath, 'nested'));
    await writeFile(path.join(documentsPath, 'nested', 'Ignore.inkstone'), data('Nested notebook'));
    await writeFile(path.join(documentsPath, 'Corrupt.inkstone'), '{bad');
    const library = new NotebookLibrary(options);
    const entries = await library.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: 'Recovered latest edits', sourcePath });
    expect((await library.read(entries[0].id)).data).toBe(recovery);
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(await readFile(options.recoveryPath, 'utf8')).toBe(recovery);
    expect(await readFile(path.join(options.root, 'legacy-migration-v1.json'), 'utf8')).toContain('migratedAt');
    await library.delete(entries[0].id);
    const restarted = new NotebookLibrary(options);
    expect(await restarted.list()).toHaveLength(0);
    expect(await restarted.list(true)).toHaveLength(1);
    expect((await readdir(directory)).includes('recovery.inkstone')).toBe(true);
  });

  it('does not add an untouched empty legacy recovery to Home', async () => {
    const { options } = await fixture();
    await writeFile(options.recoveryPath, JSON.stringify(createDocument()));
    expect(await new NotebookLibrary(options).list()).toEqual([]);
    expect(await readFile(options.recoveryPath, 'utf8')).toContain('Untitled notebook');
  });

  it('retries an interrupted migration without marking it complete or duplicating the durable document', async () => {
    const { options, documentsPath } = await fixture();
    const original = data('Interrupted import');
    const sourcePath = path.join(documentsPath, 'Retry.clawdenote');
    await writeFile(sourcePath, original);
    const rename = nodeFs.rename.bind(nodeFs);
    let failed = false;
    const spy = vi.spyOn(nodeFs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('metadata.json')) {
        failed = true;
        throw Object.assign(new Error('Simulated interrupted metadata commit'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    const first = new NotebookLibrary(options);
    expect(await first.list()).toHaveLength(1);
    await expect(readFile(path.join(options.root, 'legacy-migration-v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    spy.mockRestore();
    const restarted = new NotebookLibrary(options);
    const notes = await restarted.list();
    expect(notes).toHaveLength(1);
    expect((await restarted.read(notes[0].id)).data).toBe(original);
    expect(await readFile(path.join(options.root, 'legacy-migration-v1.json'), 'utf8')).toContain('migratedAt');
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
  });
});
