import { useState } from 'react';
import { PenLine, Plus, FolderOpen, Search, BookOpen, Trash2, RotateCcw, Pencil, ShieldCheck, ArrowUpRight, X } from 'lucide-react';
import type { LibraryEntry } from './library';

interface Props {
  entries: LibraryEntry[];
  busy: string;
  error: string;
  onCreate(): void;
  onImport(): void;
  onOpen(id: string): void;
  onDelete(id: string): Promise<void>;
  onRestore(id: string): Promise<void>;
  onRename(id: string, title: string): Promise<void>;
  onRetry(): void;
}
function modified(entry: LibraryEntry) { return Math.max(Date.parse(entry.updatedAt), Date.parse(entry.lastOpenedAt)); }
function recentLabel(entry: LibraryEntry) {
  const date = new Date(entry.deletedAt || modified(entry));
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function HomePage(props: Props) {
  const [search, setSearch] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [confirmation, setConfirmation] = useState<LibraryEntry | null>(null);
  const [rename, setRename] = useState<LibraryEntry | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const all = props.entries.filter(entry => Boolean(entry.deletedAt) === deleted);
  const visible = [...all].filter(entry => words.every(word => entry.title.toLocaleLowerCase().includes(word))).sort((a, b) => deleted ? Date.parse(b.deletedAt!) - Date.parse(a.deletedAt!) : modified(b) - modified(a));
  return <div className="library-shell">
    <header className="library-topbar">
      <div className="brand"><div className="brand-icon"><PenLine size={23}/></div><div><strong>Clawdenote<span>.</span></strong><small>A little space to think</small></div></div>
      <div className="library-top-actions"><button onClick={props.onImport} disabled={Boolean(props.busy)} aria-label="Import notebook or PDF"><FolderOpen size={17}/>Import notebook or PDF</button><button className="primary" onClick={props.onCreate} disabled={Boolean(props.busy)} aria-label="New notebook"><Plus size={18}/>New notebook</button></div>
    </header>
    <div className="library-layout">
      <aside className="library-sidebar"><div className="library-nav-title">YOUR LIBRARY</div><button aria-label="All notebooks" aria-pressed={!deleted} className={!deleted ? 'active' : ''} onClick={() => setDeleted(false)}><BookOpen size={18}/>All notebooks<span>{props.entries.filter(entry => !entry.deletedAt).length}</span></button><button aria-label="Deleted notes" aria-pressed={deleted} className={deleted ? 'active' : ''} onClick={() => setDeleted(true)}><Trash2 size={18}/>Deleted notes<span>{props.entries.filter(entry => entry.deletedAt).length}</span></button><div className="library-local"><ShieldCheck size={23}/><strong>Saved here. Ready whenever.</strong><p>Your notebooks save automatically on this laptop. Export a copy whenever you need one.</p></div></aside>
      <main className="library-main">
        <div className="library-heading"><div><span className="notebook-tag">{deleted ? 'ROOM TO RECONSIDER' : 'YOUR SPACE TO THINK'}</span><h1>{deleted ? 'Deleted notes' : 'Pick up a thought.'}</h1><p>{deleted ? 'Restore a notebook whenever you need it again.' : 'Your notebooks, saved automatically and ready to continue.'}</p></div><span className="library-total">{all.length} {all.length === 1 ? 'notebook' : 'notebooks'}</span></div>
        <div className="library-search-row"><label className="library-search"><Search size={18}/><input aria-label="Search notebooks" type="search" placeholder="Search by name…" value={search} onChange={event => setSearch(event.target.value)}/></label><span>{deleted ? 'Most recently deleted' : 'Most recent first'}</span></div>
        {props.error && <div className="library-error" role="alert"><span>{props.error}</span><button onClick={props.onRetry}>Try again</button></div>}
        {!props.busy && !visible.length && <div className="library-empty"><div><BookOpen size={32}/></div><h2>{search ? 'No matching notebooks' : deleted ? 'Nothing here for now.' : 'A fresh start, all in one place.'}</h2><p>{search ? 'Try another name or clear your search.' : deleted ? 'Notebooks you delete will appear here with an option to restore them.' : 'Create your first notebook, or bring in an existing notebook or PDF.'}</p>{!deleted && !search && <button className="primary" onClick={props.onCreate}><Plus size={17}/>Create a notebook</button>}</div>}
        <div className="library-grid">{visible.map(entry => <article className="library-card" key={entry.id}>
          <button className="library-open" aria-label={`Open notebook: ${entry.title}`} disabled={deleted || Boolean(props.busy)} onClick={() => props.onOpen(entry.id)}><div className="library-preview">{entry.previewDataUrl ? <img src={entry.previewDataUrl} alt=""/> : <div className="library-paper"><PenLine size={25}/><span>{entry.title}</span></div>}<span className="library-open-arrow"><ArrowUpRight size={17}/></span></div><div className="library-card-text"><h2>{entry.title}</h2><p>{entry.error ? 'Needs attention' : `${entry.pageCount} ${entry.pageCount === 1 ? 'page' : 'pages'}`}<span>·</span>{recentLabel(entry)}</p></div></button>
          <div className="library-card-actions">{deleted ? <button className="library-restore" aria-label={`Restore notebook: ${entry.title}`} onClick={() => void props.onRestore(entry.id)} disabled={Boolean(props.busy)}><RotateCcw size={15}/>Restore notebook</button> : <><button className="icon-button" title="Rename notebook" aria-label={`Rename notebook: ${entry.title}`} disabled={Boolean(props.busy)} onClick={() => { setRename(entry); setNewTitle(entry.title); }}><Pencil size={15}/></button><button className="icon-button" title="Delete notebook" aria-label={`Delete notebook: ${entry.title}`} disabled={Boolean(props.busy)} onClick={() => setConfirmation(entry)}><Trash2 size={15}/></button></>}</div>
        </article>)}</div>
      </main>
    </div>
    {props.busy && <div className="busy-overlay" role="status"><span className="spinner"/>{props.busy}</div>}
    {confirmation && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Delete notebook?"><header><h2>Delete notebook?</h2><button className="icon-button" aria-label="Close dialog" onClick={() => setConfirmation(null)}><X size={19}/></button></header><p className="modal-description">“{confirmation.title}” will move to Deleted notes. You can restore it later.</p><div className="modal-actions"><button onClick={() => setConfirmation(null)}>Keep notebook</button><button className="danger" onClick={async () => { await props.onDelete(confirmation.id); setConfirmation(null); }}>Delete notebook</button></div></section></div>}
    {rename && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label="Rename notebook" onSubmit={async event => { event.preventDefault(); if (newTitle.trim()) { await props.onRename(rename.id, newTitle.trim()); setRename(null); } }}><header><h2>Rename notebook</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setRename(null)}><X size={19}/></button></header><label className="form-label" htmlFor="library-rename">Notebook name</label><input autoFocus id="library-rename" className="library-name-input" aria-label="Notebook name" value={newTitle} maxLength={120} onChange={event => setNewTitle(event.target.value)}/><div className="modal-actions"><button type="button" onClick={() => setRename(null)}>Cancel</button><button className="primary" disabled={!newTitle.trim()} type="submit">Rename notebook</button></div></form></div>}
  </div>;
}
