const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DOCUMENT = 300 * 1024 * 1024;
const MAX_PREVIEW = 350_000;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const missing = error => error && error.code === 'ENOENT';

function notebook(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_DOCUMENT) throw new Error('Invalid notebook data or notebook exceeds 300 MB.');
  let value;
  try { value = JSON.parse(data); } catch { throw new Error('This notebook contains unreadable JSON. Its original file has been preserved.'); }
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !value.id || value.id.length > 256 || typeof value.title !== 'string' || value.title.length > 1000 || !validDate(value.updatedAt) || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 1000 || !value.pdfSources || typeof value.pdfSources !== 'object' || Array.isArray(value.pdfSources)) throw new Error('This file is not a supported Clawdenote notebook.');
  for (const page of value.pages) {
    if (!page || typeof page.id !== 'string' || !Array.isArray(page.items) || page.items.length > 100_000 || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 || page.width > 20_000 || page.height > 20_000 || !['blank', 'lined', 'graph', 'dot'].includes(page.paper) || typeof page.paperColor !== 'string' || page.paperColor.length > 128) throw new Error('This notebook contains an invalid page.');
  }
  return value;
}

function preview(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid notebook preview.');
  // Large thumbnails never prevent the notebook itself from being saved.
  if (value.length > MAX_PREVIEW) return undefined;
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)) throw new Error('Invalid notebook preview.');
  return value;
}

function source(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Invalid notebook source path.');
  return path.resolve(value);
}
function sourceKey(value) { return value ? path.resolve(value).toLocaleLowerCase('en-US') : ''; }
function meaningful(value) {
  return !/^(?:untitled(?: notebook)?|new notebook)?$/i.test(value.title.trim()) || value.pages.length > 1 || Object.keys(value.pdfSources).length > 0 || value.pages.some(page => page.items.length > 0 || page.pdf || page.paper !== 'blank' || !['#fff', '#ffffff'].includes((page.paperColor || '').toLowerCase()));
}

async function atomicWrite(destination, data) {
  const temporary = destination + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, destination);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

class NotebookLibrary {
  constructor(options) {
    if (!options || !path.isAbsolute(options.root)) throw new Error('A local library directory is required.');
    this.root = path.resolve(options.root);
    this.notes = path.join(this.root, 'notes');
    this.trash = path.join(this.root, 'trash');
    this.recoveryPath = options.recoveryPath;
    this.documentsPath = options.documentsPath;
    this.now = options.now || (() => new Date().toISOString());
    this.warn = options.onWarning || (() => {});
    this.queue = Promise.resolve();
    this.initialized = null;
  }
  assertId(id) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid notebook ID.'); return id.toLowerCase(); }
  directory(id, deleted = false) { return path.join(deleted ? this.trash : this.notes, this.assertId(id)); }
  async isDirectory(directory) {
    try { const stat = await fs.lstat(directory); if (stat.isSymbolicLink()) throw new Error('Linked notebook directories are not supported.'); return stat.isDirectory(); }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  async safeRead(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOCUMENT) throw new Error('This notebook file cannot be read safely.');
    return { data: await fs.readFile(filename, 'utf8'), stat };
  }
  async metadata(directory, entry, document) {
    const stored = { ...entry, documentId: document.id, documentUpdatedAt: document.updatedAt };
    delete stored.error;
    await atomicWrite(path.join(directory, 'metadata.json'), JSON.stringify(stored));
    return stored;
  }
  publicEntry(stored) {
    const { documentId, documentUpdatedAt, ...entry } = stored;
    return entry;
  }
  async load(id, deleted = false) {
    const directory = this.directory(id, deleted);
    if (!await this.isDirectory(directory)) throw new Error(deleted ? 'This notebook is no longer in Trash.' : 'This notebook is missing or is in Trash.');
    let stored, metadataStat;
    try {
      const read = await this.safeRead(path.join(directory, 'metadata.json'));
      const candidate = JSON.parse(read.data);
      if (candidate.id !== id || typeof candidate.title !== 'string' || candidate.title.length > 1000 || !validDate(candidate.createdAt) || !validDate(candidate.updatedAt) || !validDate(candidate.lastOpenedAt) || !Number.isInteger(candidate.pageCount) || candidate.pageCount < 1 || candidate.pageCount > 1000) throw new Error('Invalid notebook metadata.');
      stored = {
        id, title: candidate.title, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
        lastOpenedAt: candidate.lastOpenedAt, pageCount: candidate.pageCount,
        ...(candidate.previewDataUrl && preview(candidate.previewDataUrl) ? { previewDataUrl: candidate.previewDataUrl } : {}),
        ...(candidate.sourcePath ? { sourcePath: source(candidate.sourcePath) } : {}),
        ...(deleted ? { deletedAt: validDate(candidate.deletedAt) ? candidate.deletedAt : read.stat.mtime.toISOString() } : {}),
        documentId: candidate.documentId, documentUpdatedAt: candidate.documentUpdatedAt,
      };
      metadataStat = read.stat;
    } catch (error) { if (!missing(error)) this.warn(`Notebook ${id}: metadata will be recovered from its document.`); }
    try {
      const documentStat = await fs.lstat(path.join(directory, 'document.json'));
      if (!documentStat.isFile() || documentStat.isSymbolicLink()) throw new Error('Notebook data is missing or linked.');
      // Normal listing reads small metadata, not every embedded PDF in the library.
      if (stored && typeof stored.documentId === 'string' && metadataStat.mtimeMs >= documentStat.mtimeMs) return stored;
      const read = await this.safeRead(path.join(directory, 'document.json'));
      const document = notebook(read.data);
      const createdAt = stored?.createdAt || read.stat.birthtime.toISOString();
      stored = {
        ...(stored || {}), id, title: document.title, pageCount: document.pages.length, createdAt,
        updatedAt: stored ? new Date(Math.max(Date.parse(stored.updatedAt), read.stat.mtimeMs)).toISOString() : read.stat.mtime.toISOString(),
        lastOpenedAt: stored?.lastOpenedAt || createdAt,
        ...(deleted ? { deletedAt: stored?.deletedAt || read.stat.mtime.toISOString() } : {}),
      };
      return await this.metadata(directory, stored, document);
    } catch (error) {
      const stat = await fs.stat(directory);
      return { ...(stored || { id, title: 'Unreadable notebook', createdAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), lastOpenedAt: stat.birthtime.toISOString(), pageCount: 0 }), ...(deleted ? { deletedAt: stored?.deletedAt || stat.mtime.toISOString() } : {}), error: 'This notebook could not be read. Its files have been preserved.' };
    }
  }
  async entries(includeDeleted = false) {
    const entries = [];
    for (const deleted of includeDeleted ? [false, true] : [false]) {
      const names = await fs.readdir(deleted ? this.trash : this.notes);
      for (const name of names) {
        if (!ID.test(name)) continue;
        try { entries.push(await this.load(name.toLowerCase(), deleted)); }
        catch (error) { this.warn(`Notebook ${name} was preserved but could not be listed.`); }
      }
    }
    return entries.sort((a, b) => Math.max(Date.parse(b.updatedAt), Date.parse(b.lastOpenedAt)) - Math.max(Date.parse(a.updatedAt), Date.parse(a.lastOpenedAt)) || a.id.localeCompare(b.id));
  }
  async initialize() {
    await fs.mkdir(this.notes, { recursive: true });
    await fs.mkdir(this.trash, { recursive: true });
    await this.entries(true); // Repair interrupted document/metadata pairs before migration.
    const marker = path.join(this.root, 'legacy-migration-v1.json');
    try { await fs.access(marker); return; } catch (error) { if (!missing(error)) throw error; }
    let durable = true;
    const candidates = [];
    if (this.documentsPath) {
      try {
        for (const item of await fs.readdir(this.documentsPath, { withFileTypes: true })) {
          if (item.isFile() && /\.(?:clawdenote|inkstone)$/i.test(item.name)) candidates.push({ path: path.join(this.documentsPath, item.name), recovery: false });
        }
      } catch (error) { if (!missing(error)) { durable = false; this.warn('Existing notebooks could not be checked for migration.'); } }
    }
    if (this.recoveryPath) candidates.push({ path: this.recoveryPath, recovery: true });
    for (const candidate of candidates) {
      let data, document;
      try { data = (await this.safeRead(candidate.path)).data; document = notebook(data); }
      catch (error) {
        if (!missing(error)) {
          this.warn(`Original notebook ${path.basename(candidate.path)} was left untouched because it could not be migrated.`);
          if (error.code) durable = false; // Retry inaccessible originals; malformed JSON remains untouched.
        }
        continue;
      }
      if (candidate.recovery && !meaningful(document)) continue;
      try { await this.importInternal(data, candidate.path, undefined, true); }
      catch (error) { durable = false; this.warn(`Migration will retry ${path.basename(candidate.path)} on the next start.`); }
    }
    if (durable) await atomicWrite(marker, JSON.stringify({ version: 1, migratedAt: this.now() }));
  }
  run(work) {
    const operation = this.queue.then(async () => {
      if (!this.initialized) this.initialized = this.initialize().catch(error => { this.initialized = null; throw error; });
      await this.initialized;
      return work();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async writeInternal(id, data, previewDataUrl, sourcePath, previous) {
    const document = notebook(data), image = preview(previewDataUrl), now = this.now();
    const directory = this.directory(id);
    const entry = {
      id, title: document.title, pageCount: document.pages.length,
      createdAt: previous?.createdAt || now, updatedAt: now, lastOpenedAt: previous?.lastOpenedAt || now,
      ...(previous?.previewDataUrl ? { previewDataUrl: previous.previewDataUrl } : {}),
      ...(image ? { previewDataUrl: image } : {}),
      ...(sourcePath || previous?.sourcePath ? { sourcePath: sourcePath || previous.sourcePath } : {}),
    };
    await atomicWrite(path.join(directory, 'document.json'), data);
    return this.metadata(directory, entry, document);
  }
  async createInternal(data, previewDataUrl, sourcePath) {
    notebook(data); preview(previewDataUrl);
    const id = randomUUID(), directory = this.directory(id);
    await fs.mkdir(directory);
    try { return await this.writeInternal(id, data, previewDataUrl, sourcePath); }
    catch (error) {
      // Leave any durable document for startup repair; never delete a user's data.
      this.warn(`Notebook ${id} may need metadata recovery after an interrupted save.`);
      throw error;
    }
  }
  async readInternal(id, markOpened = true) {
    const stored = await this.load(id);
    if (stored.error) throw new Error(stored.error);
    const read = await this.safeRead(path.join(this.directory(id), 'document.json'));
    const document = notebook(read.data);
    stored.title = document.title;
    stored.pageCount = document.pages.length;
    if (markOpened) {
      stored.lastOpenedAt = this.now();
      await this.metadata(this.directory(id), stored, document);
    }
    return { entry: this.publicEntry(stored), data: read.data };
  }
  async restoreInternal(id) {
    const stored = await this.load(id, true);
    if (await this.isDirectory(this.directory(id))) throw new Error('A notebook with this ID already exists.');
    await fs.rename(this.directory(id, true), this.directory(id));
    delete stored.deletedAt;
    stored.lastOpenedAt = this.now();
    if (stored.error) return stored;
    const document = notebook((await this.safeRead(path.join(this.directory(id), 'document.json'))).data);
    await this.metadata(this.directory(id), stored, document);
    return stored;
  }
  async importInternal(data, sourcePath, previewDataUrl, migrating = false) {
    const document = notebook(data), original = source(sourcePath);
    preview(previewDataUrl);
    const entries = await this.entries(true);
    const existing = entries.find(entry => original && sourceKey(entry.sourcePath) === sourceKey(original)) || entries.find(entry => !entry.error && entry.documentId === document.id);
    if (existing) {
      if (existing.deletedAt && !migrating) await this.restoreInternal(existing.id);
      // A restart must never resurrect a note that the user put in Trash.
      if (existing.deletedAt && migrating) return { entry: this.publicEntry(existing), data, imported: false };
      let latest = await this.readInternal(existing.id, !migrating);
      const current = notebook(latest.data);
      if (migrating && Date.parse(document.updatedAt) > Date.parse(current.updatedAt)) {
        const saved = await this.writeInternal(existing.id, data, previewDataUrl, existing.sourcePath || original, existing);
        latest = { entry: this.publicEntry(saved), data };
      } else if (!existing.sourcePath && original) {
        existing.sourcePath = original;
        await this.metadata(this.directory(existing.id), existing, current);
        latest.entry.sourcePath = original;
      }
      return { ...latest, imported: false };
    }
    const entry = await this.createInternal(data, previewDataUrl, original);
    return { entry: this.publicEntry(entry), data, imported: true };
  }
  list(includeDeleted = false) { if (typeof includeDeleted !== 'boolean') return Promise.reject(new Error('Invalid library listing request.')); return this.run(async () => (await this.entries(includeDeleted)).map(entry => this.publicEntry(entry))); }
  read(id) { id = this.assertId(id); return this.run(() => this.readInternal(id)); }
  save(id, data, previewDataUrl) {
    if (id !== null) id = this.assertId(id);
    notebook(data); preview(previewDataUrl);
    return this.run(async () => {
      if (id === null) return this.publicEntry(await this.createInternal(data, previewDataUrl));
      const previous = await this.load(id); // Missing/trashed IDs cannot be recreated by stale autosave.
      if (previous.error) throw new Error(previous.error);
      return this.publicEntry(await this.writeInternal(id, data, previewDataUrl, undefined, previous));
    });
  }
  import(data, sourcePath, previewDataUrl) { notebook(data); source(sourcePath); preview(previewDataUrl); return this.run(() => this.importInternal(data, sourcePath, previewDataUrl)); }
  delete(id) {
    id = this.assertId(id);
    return this.run(async () => {
      const stored = await this.load(id);
      if (await this.isDirectory(this.directory(id, true))) throw new Error('This notebook is already in Trash.');
      await fs.rename(this.directory(id), this.directory(id, true));
      stored.deletedAt = this.now();
      if (!stored.error) {
        const document = notebook((await this.safeRead(path.join(this.directory(id, true), 'document.json'))).data);
        await this.metadata(this.directory(id, true), stored, document);
      }
    });
  }
  restore(id) { id = this.assertId(id); return this.run(async () => this.publicEntry(await this.restoreInternal(id))); }
}

module.exports = { NotebookLibrary };
