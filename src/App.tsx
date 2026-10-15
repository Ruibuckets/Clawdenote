import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { PenLine, Highlighter, Eraser, MousePointer2, Hand, Minus, ArrowUpRight, Square, Circle, Type, FilePenLine, Undo2, Redo2, FolderOpen, Download, Save, Plus, Copy, Trash2, ChevronUp, ChevronDown, ZoomIn, ZoomOut, Maximize, ImagePlus, Printer, HelpCircle, X, Check, BookOpen, Layers, ShieldCheck, ChevronRight, Home, LassoSelect, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, MoveHorizontal } from 'lucide-react';
import { createDocument, createPage, clonePage, validateDocument, type DocumentModel, type PageModel, type InkItem, type Point } from './model';
import { drawPaper, drawItems, drawItem, hitTest, translateItem, preloadImages, subscribeToImageLoads } from './drawing';
import { importPdf, renderPdfBackground, getPdfTextBlocks, replacePdfText, exportPdf, exportPageImage, exportPageSvg, type PdfTextBlock } from './pdf';
import { desktop } from './desktop';
import { version as appVersion } from '../package.json';
import { inkDotCursor } from './cursor';
import { HomePage } from './Home';
import type { LibraryEntry } from './library';
import { selectWithinLasso, getSelectionBounds, eraseInkPath } from './selection';
type Tool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'lasso' | 'hand' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'pdftext';
const TOOLS: {
    id: Tool;
    label: string;
    icon: typeof PenLine;
    key?: string;
}[] = [
    { id: 'pen', label: 'Pen', icon: PenLine, key: 'P' }, { id: 'highlighter', label: 'Highlighter', icon: Highlighter, key: 'H' }, { id: 'eraser', label: 'Eraser', icon: Eraser, key: 'E' },
    { id: 'select', label: 'Select & move', icon: MousePointer2, key: 'V' }, { id: 'lasso', label: 'Lasso select', icon: LassoSelect, key: 'Q' }, { id: 'hand', label: 'Pan', icon: Hand },
    { id: 'line', label: 'Line', icon: Minus, key: 'L' }, { id: 'arrow', label: 'Arrow', icon: ArrowUpRight }, { id: 'rectangle', label: 'Rectangle', icon: Square }, { id: 'ellipse', label: 'Ellipse', icon: Circle },
    { id: 'text', label: 'Text', icon: Type, key: 'T' }, { id: 'pdftext', label: 'Edit PDF text', icon: FilePenLine }
];
const COLORS = ['#27352f', '#315c48', '#377ba1', '#7459a0', '#d15b55', '#d58f30', '#f2cc57', '#ffffff'];
const paperNames: Record<string, string> = { blank: 'Blank', lined: 'Lined', graph: 'Graph', dot: 'Dotted' };
const uid = () => crypto.randomUUID();
const AUTOSAVE_IDLE_MS = 4000;
type FitMode = 'width' | 'page' | 'manual';
function initialPanels() {
    try { const saved = JSON.parse(localStorage.getItem('clawdenote-panels-v1') || 'null'); if (typeof saved?.pages === 'boolean' && typeof saved?.tools === 'boolean') return saved as { pages: boolean; tools: boolean }; } catch { /* Layout preferences must never prevent opening a notebook. */ }
    return { pages: window.innerWidth >= 900, tools: window.innerWidth >= 900 };
}
const filename = (title: string) => title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Notebook';
function IconButton({ label, children, onClick, disabled, active, className = '' }: {
    label: string;
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    className?: string;
}) {
    return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Modal({ title, children, onClose }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
}) {
    return <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget)
        onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={19}/></IconButton></header>{children}</section></div>;
}
const Thumbnail = memo(function Thumbnail({ model, page, interaction, activity }: {
    model: DocumentModel;
    page: PageModel;
    interaction: { current: number | null };
    activity: { current: number };
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const background = useRef<{ source: string | undefined; index: number | undefined; image: Promise<HTMLCanvasElement | null> } | null>(null);
    useEffect(() => {
        let active = true, visible = false, timer: ReturnType<typeof setTimeout> | undefined, idle: number | undefined;
        function schedule() { timer = setTimeout(() => { idle = requestIdleCallback(() => { void paint().catch(() => {}); }, { timeout: 1000 }); }, Math.max(250, AUTOSAVE_IDLE_MS - (performance.now() - activity.current))); }
        async function paint() {
            if (!active || !visible || !canvas.current) return;
            if (interaction.current !== null || performance.now() - activity.current < AUTOSAVE_IDLE_MS) { schedule(); return; }
            const source = page.pdf ? model.pdfSources[page.pdf.sourceId] : undefined;
            if (!background.current || background.current.source !== source || background.current.index !== page.pdf?.pageIndex) background.current = { source, index: page.pdf?.pageIndex, image: renderPdfBackground(model, page, .19) };
            const image = await background.current.image; await preloadImages(page.items);
            if (!active || !canvas.current) return;
            if (interaction.current !== null || performance.now() - activity.current < AUTOSAVE_IDLE_MS) { schedule(); return; }
            const c = canvas.current; c.width = 112; c.height = Math.round(112 * page.height / page.width);
            const ctx = c.getContext('2d')!; ctx.scale(112 / page.width, 112 / page.width);
            if (image) ctx.drawImage(image, 0, 0, page.width, page.height); else drawPaper(ctx, page);
            drawItems(ctx, page.items);
        }
        const observer = new IntersectionObserver(entries => {
            visible = entries.some(entry => entry.isIntersecting);
            clearTimeout(timer); if (idle !== undefined) cancelIdleCallback(idle);
            if (visible) schedule();
        }, { root: canvas.current?.closest('.page-list') });
        if (canvas.current) observer.observe(canvas.current);
        return () => { active = false; observer.disconnect(); clearTimeout(timer); if (idle !== undefined) cancelIdleCallback(idle); };
    }, [page, model.pdfSources]);
    return <canvas ref={canvas} width={112} height={Math.round(112 * page.height / page.width)} aria-hidden="true"/>;
}, (previous, next) => previous.page === next.page && previous.model.pdfSources === next.model.pdfSources);
export default function App() {
    const [entries, setEntries] = useState<LibraryEntry[]>([]);
    const [active, setActive] = useState<{ entry: LibraryEntry; model: DocumentModel } | null>(null);
    const [busy, setBusy] = useState('Opening your library…');
    const [error, setError] = useState('');
    const operation = useRef<Promise<void>>(Promise.resolve());
    const working = useRef(false);
    function upsert(entry: LibraryEntry) { setEntries(previous => [entry, ...previous.filter(item => item.id !== entry.id)]); }
    async function refresh() { setEntries(await desktop.libraryList(true)); }
    function runLibrary(label: string, task: () => Promise<void>) {
        if (working.current) return operation.current;
        working.current = true; setBusy(label); setError('');
        const pendingOperation = task().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { working.current = false; setBusy(''); });
        operation.current = pendingOperation;
        return pendingOperation;
    }
    useEffect(() => { void runLibrary('Opening your library…', refresh); }, []);
    useEffect(() => { if (active) return; return desktop.onClose(() => { void operation.current.finally(() => desktop.closeReady()); }); }, [active?.entry.id]);
    async function createNotebook() {
        await runLibrary('Creating notebook…', async () => {
            const model = createDocument('Untitled notebook');
            const entry = await desktop.librarySave(null, JSON.stringify(model));
            upsert(entry); setActive({ entry, model });
        });
    }
    async function openNotebook(id: string) {
        await runLibrary('Opening notebook…', async () => {
            const saved = await desktop.libraryRead(id);
            const model = validateDocument(JSON.parse(saved.data));
            upsert(saved.entry); setActive({ entry: saved.entry, model });
        });
    }
    async function importNotebook() {
        await runLibrary('Opening document…', async () => {
            const file = await desktop.open('document');
            if (!file) return;
            let model: DocumentModel;
            if (file.name.toLowerCase().endsWith('.pdf')) {
                const imported = await importPdf(file.data, file.name);
                model = createDocument(file.name.replace(/\.pdf$/i, ''));
                model.pages = imported.pages; model.pdfSources = { [imported.sourceId]: imported.sourceData };
            } else model = validateDocument(JSON.parse(new TextDecoder().decode(file.data)));
            const saved = await desktop.libraryImport(JSON.stringify(model), file.path);
            upsert(saved.entry); setActive({ entry: saved.entry, model: validateDocument(JSON.parse(saved.data)) });
        });
    }
    if (active) return <><NotebookEditor key={active.entry.id} notebookId={active.entry.id} initialModel={active.model} onSaved={upsert} onHome={async () => { setActive(null); await runLibrary('Loading notebooks…', refresh); }} onNew={createNotebook} onOpen={importNotebook}/>{error && <div className="toast library-operation-error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setError('')}><X size={16}/></button></div>}</>;
    return <HomePage entries={entries} busy={busy} error={error} onCreate={() => void createNotebook()} onImport={() => void importNotebook()} onOpen={id => void openNotebook(id)} onRetry={() => void runLibrary('Loading notebooks…', refresh)} onDelete={id => runLibrary('Moving notebook to Deleted notes…', async () => { await desktop.libraryDelete(id); await refresh(); })} onRestore={id => runLibrary('Restoring notebook…', async () => { await desktop.libraryRestore(id); await refresh(); })} onRename={(id, title) => runLibrary('Renaming notebook…', async () => { const saved = await desktop.libraryRead(id); const model = validateDocument(JSON.parse(saved.data)); model.title = title; model.updatedAt = new Date().toISOString(); upsert(await desktop.librarySave(id, JSON.stringify(model), saved.entry.previewDataUrl)); })}/>;
}
interface EditorProps {
    notebookId: string;
    initialModel: DocumentModel;
    onSaved(entry: LibraryEntry): void;
    onHome(): Promise<void>;
    onNew(): Promise<void>;
    onOpen(): Promise<void>;
}
function NotebookEditor({ notebookId, initialModel, onSaved, onHome, onNew, onOpen }: EditorProps) {
    const [model, setModelState] = useState<DocumentModel>(() => initialModel);
    const modelRef = useRef(model);
    const [previewModel, setPreviewModel] = useState(initialModel);
    const thumbnailPages = useRef(new Map(initialModel.pages.map(page => [page.id, page])));
    const [panels, setPanels] = useState(initialPanels);
    const [pageId, setPageId] = useState(model.pages[0].id);
    const page = model.pages.find(p => p.id === pageId) || model.pages[0];
    const pageRef = useRef(page);
    pageRef.current = page;
    const [tool, setTool] = useState<Tool>('pen');
    const toolRef = useRef<Tool>('pen'); toolRef.current = tool;
    const lastWritingTool = useRef<'pen' | 'highlighter'>('pen');
    const [color, setColor] = useState(COLORS[0]);
    const [width, setWidth] = useState(2.5);
    const [eraserSize, setEraserSize] = useState(18);
    const [fontSize, setFontSize] = useState(22);
    const [pressure, setPressure] = useState(true);
    const [penOnly, setPenOnly] = useState(false);
    const [touchDraw, setTouchDraw] = useState(false);
    const [smoothing, setSmoothing] = useState(.55);
    const [paper, setPaper] = useState<PageModel['paper']>('blank');
    const [paperColor, setPaperColor] = useState('#ffffff');
    const [zoom, setZoom] = useState(.67);
    const [fitMode, setFitMode] = useState<FitMode>('width');
    const fitModeRef = useRef<FitMode>('width');
    const fitPending = useRef(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [lassoIds, setLassoIds] = useState<string[]>([]);
    const lassoIdsRef = useRef<string[]>([]);
    const lassoPlan = useRef<{ original: readonly InkItem[]; items: InkItem[]; selectedIds: string[] } | null>(null);
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const [dirty, setDirty] = useState(false);
    const dirtyRef = useRef(false);
    const [saveStatus, setSaveStatus] = useState('Saved to your library');
    const [filePath, setFilePath] = useState('');
    const [toast, setToast] = useState('');
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [busy, setBusy] = useState('');
    const [modal, setModal] = useState<'export' | 'help' | 'delete' | 'clear' | null>(null);
    const [exportFormat, setExportFormat] = useState('pdf');
    const [editor, setEditor] = useState<{
        mode: 'new' | 'edit' | 'pdf';
        x: number;
        y: number;
        text: string;
        id?: string;
        block?: PdfTextBlock;
    } | null>(null);
    const [blocks, setBlocks] = useState<PdfTextBlock[]>([]);
    const [pdfReady, setPdfReady] = useState(false);
    const [printImages, setPrintImages] = useState<string[]>([]);
    const history = useRef<{
        past: DocumentModel[];
        future: DocumentModel[];
    }>({ past: [], future: [] });
    const [historyVersion, setHistoryVersion] = useState(0);
    const bgCanvas = useRef<HTMLCanvasElement>(null);
    const committedCanvas = useRef<HTMLCanvasElement>(null);
    const inkCanvas = useRef<HTMLCanvasElement>(null);
    const eraserIndicator = useRef<HTMLDivElement>(null);
    const hoverPoint = useRef<Point | null>(null);
    const hoverInside = useRef(false);
    const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autosaveIdle = useRef<number | null>(null);
    const lastActivity = useRef(performance.now());
    const lastSavedModel = useRef(initialModel);
    const saveQueue = useRef<Promise<void>>(Promise.resolve());
    const saving = useRef(false);
    const viewport = useRef<HTMLDivElement>(null);
    const committedPaint = useRef<{
        pageId: string;
        items: readonly InkItem[];
        scale: number;
    } | null>(null);
    const inkFrame = useRef<number | null>(null);
    const livePreview = useRef<readonly InkItem[] | null>(null);
    const pending = useRef<InkItem | null>(null);
    const activePointer = useRef<number | null>(null);
    const drag = useRef<{
        point: Point;
        latest: Point;
        clientX: number;
        clientY: number;
        rect: DOMRect;
        item?: InkItem;
        scrollLeft?: number;
        scrollTop?: number;
        changed?: boolean;
        eraseItems?: readonly InkItem[];
        eraseLast?: Point;
        lasso?: Point[];
        group?: { items: readonly InkItem[]; ids: string[] };
        before: DocumentModel;
    } | null>(null);
    const mounted = useRef(true);
    const space = useRef(false);
    const busyRef = useRef(false);
    const closingRef = useRef(false);
    function notify(message: string) { setToast(message); if (toastTimer.current)
        clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4500); }
    function markDirty(value: boolean) { dirtyRef.current = value; setDirty(value); }
    function updateModel(next: DocumentModel, remember = true) { if (activePointer.current !== null) cancelInteraction(); if (lassoPlan.current && next.pages.find(p => p.id === pageRef.current.id)?.items !== lassoPlan.current.original) clearSelection(); if (remember) {
        history.current.past.push(modelRef.current);
        if (history.current.past.length > 40)
            history.current.past.shift();
        history.current.future = [];
        setHistoryVersion(v => v + 1);
    } const snapshot = { ...next, updatedAt: new Date().toISOString() }; modelRef.current = snapshot; setModelState(snapshot); markDirty(true); setSaveStatus('Unsaved changes'); recordActivity(); }
    function changePage(fn: (p: PageModel) => PageModel, remember = true) { const doc = modelRef.current; updateModel({ ...doc, pages: doc.pages.map(p => p.id === pageRef.current.id ? fn(p) : p) }, remember); }
    function clearSelection() { setSelected(null); selectedRef.current = null; setLassoIds([]); lassoIdsRef.current = []; lassoPlan.current = null; livePreview.current = null; }
    function chooseTool(next: Tool) { if (activePointer.current !== null) cancelInteraction(); if (next === 'pen' || next === 'highlighter') lastWritingTool.current = next; toolRef.current = next; setTool(next); clearSelection(); scheduleInkPaint(); }
    function undo() { cancelInteraction(); const h = history.current; if (!h.past.length)
        return; h.future.push(modelRef.current); const next = h.past.pop()!; updateModel(next, false); setHistoryVersion(v => v + 1); clearSelection(); if (!next.pages.some(p => p.id === pageId))
        setPageId(next.pages[0].id); }
    function redo() { cancelInteraction(); const h = history.current; if (!h.future.length)
        return; h.past.push(modelRef.current); const next = h.future.pop()!; updateModel(next, false); setHistoryVersion(v => v + 1); clearSelection(); if (!next.pages.some(p => p.id === pageId))
        setPageId(next.pages[0].id); }
    async function runTask(label: string, task: () => Promise<void>) { if (busyRef.current)
        return; busyRef.current = true; setBusy(label); try {
        await task();
    }
    catch (error) {
        notify(error instanceof Error ? error.message : String(error));
    }
    finally {
        busyRef.current = false;
        setBusy('');
        scheduleAutosave();
    } }
    function capturePreview() {
        try {
            if (!bgCanvas.current?.width || !committedCanvas.current?.width) return undefined;
            const preview = document.createElement('canvas'); preview.width = 140; preview.height = Math.round(140 * pageRef.current.height / pageRef.current.width);
            const ctx = preview.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, preview.width, preview.height);
            ctx.drawImage(bgCanvas.current, 0, 0, preview.width, preview.height); ctx.drawImage(committedCanvas.current, 0, 0, preview.width, preview.height);
            return preview.toDataURL('image/jpeg', .65);
        } catch { return undefined; }
    }
    function cancelAutosave() {
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current); autosaveTimer.current = null;
        if (autosaveIdle.current !== null) cancelIdleCallback(autosaveIdle.current); autosaveIdle.current = null;
    }
    function recordActivity() { lastActivity.current = performance.now(); cancelAutosave(); scheduleAutosave(); }
    function scheduleAutosave() {
        cancelAutosave();
        if (!mounted.current || !dirtyRef.current || activePointer.current !== null || saving.current || busyRef.current || closingRef.current) return;
        autosaveTimer.current = setTimeout(() => {
            autosaveTimer.current = null;
            autosaveIdle.current = requestIdleCallback(() => { autosaveIdle.current = null; void persistLibrary(false).catch(() => {}); }, { timeout: 1000 });
        }, Math.max(0, AUTOSAVE_IDLE_MS - (performance.now() - lastActivity.current)));
    }
    function persistLibrary(force = true) {
        if (force && activePointer.current !== null && drag.current) completeInteraction(drag.current.latest);
        cancelAutosave();
        const run = saveQueue.current.then(async () => {
            // Recheck immediately before doing any cloning, encoding, or disk work.
            // A queued save must yield if the pen has started moving again.
            if (!force && (activePointer.current !== null || busyRef.current || closingRef.current || performance.now() - lastActivity.current < AUTOSAVE_IDLE_MS)) { scheduleAutosave(); return; }
            do {
            const snapshot = modelRef.current;
            if (lastSavedModel.current === snapshot) { if (activePointer.current === null && mounted.current) { markDirty(false); setSaveStatus('Saved to your library'); setPreviewModel(snapshot); } return; }
            saving.current = true;
            setSaveStatus('Saving…');
            try {
                const data = JSON.stringify(snapshot), preview = capturePreview();
                const entry = await desktop.librarySave(notebookId, data, preview);
                lastSavedModel.current = snapshot;
                if (mounted.current && activePointer.current === null) {
                    if (force || performance.now() - lastActivity.current >= AUTOSAVE_IDLE_MS) { onSaved(entry); setPreviewModel(snapshot); }
                    if (modelRef.current === snapshot) { markDirty(false); setSaveStatus('Saved to your library'); }
                    else setSaveStatus('Unsaved changes');
                }
            } catch (error) { lastActivity.current = performance.now(); if (mounted.current) { setSaveStatus('Save failed'); notify('Could not save changes. Try Save again, or use Save a copy.'); } throw error; }
            finally { saving.current = false; scheduleAutosave(); }
            } while (force && lastSavedModel.current !== modelRef.current);
        });
        saveQueue.current = run.catch(() => {}); return run;
    }
    async function save(saveAs = false) {
        if (!saveAs) { await persistLibrary(); notify('Saved to your library'); return true; }
        const snapshot = modelRef.current;
        const result = await desktop.save(JSON.stringify(snapshot), { name: filename(snapshot.title) + '.clawdenote', extension: 'clawdenote', saveAs: true, currentPath: filePath });
        if (!result) return false; setFilePath(result.path); notify('Copy saved to ' + result.path); return true;
    }
    async function openDocument() { await runTask('Opening document…', async () => { await persistLibrary(); await onOpen(); }); }
    async function goHome() { await runTask('Saving notebook…', async () => { await persistLibrary(); await onHome(); }); }
    async function newNotebook() { await runTask('Saving notebook…', async () => { await persistLibrary(); await onNew(); }); }
    async function appendPdf() { await runTask('Importing PDF pages…', async () => { const file = await desktop.open('pdf'); if (!file)
        return; const imported = await importPdf(file.data, file.name); const doc = modelRef.current; updateModel({ ...doc, pages: [...doc.pages, ...imported.pages], pdfSources: { ...doc.pdfSources, [imported.sourceId]: imported.sourceData } }); setPageId(imported.pages[0].id); notify(imported.pages.length + ' PDF pages added'); }); }
    function addPage() { const next = createPage(paper, paperColor); const doc = modelRef.current; const index = doc.pages.findIndex(p => p.id === pageRef.current.id); const pages = [...doc.pages]; pages.splice(index + 1, 0, next); updateModel({ ...doc, pages }); setPageId(next.id); setSelected(null); }
    function duplicatePage() { const copied = clonePage(pageRef.current); const doc = modelRef.current; const pages = [...doc.pages]; pages.splice(pages.findIndex(p => p.id === pageRef.current.id) + 1, 0, copied); updateModel({ ...doc, pages }); setPageId(copied.id); setSelected(null); }
    function movePage(direction: number) { const doc = modelRef.current; const i = doc.pages.findIndex(p => p.id === pageRef.current.id); const j = i + direction; if (j < 0 || j >= doc.pages.length)
        return; const pages = [...doc.pages]; [pages[i], pages[j]] = [pages[j], pages[i]]; updateModel({ ...doc, pages }); }
    function deletePage() { const doc = modelRef.current; if (doc.pages.length === 1)
        return; const index = doc.pages.findIndex(p => p.id === pageRef.current.id); const pages = doc.pages.filter(p => p.id !== pageRef.current.id); updateModel({ ...doc, pages }); setPageId(pages[Math.min(index, pages.length - 1)].id); setSelected(null); setModal(null); }
    function selectPage(id: string) { setPageId(id); setSelected(null); setBlocks([]); }
    function refreshFit() {
        if (!viewport.current || fitModeRef.current === 'manual') return;
        if (activePointer.current !== null) { fitPending.current = true; return; }
        fitPending.current = false;
        const v = viewport.current, current = pageRef.current, style = getComputedStyle(v);
        const availableWidth = v.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
        const availableHeight = v.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 24;
        const scale = fitModeRef.current === 'width' ? availableWidth / current.width : Math.min(availableWidth / current.width, availableHeight / current.height);
        setZoom(Math.max(.1, Math.min(3, scale)));
    }
    function fit(mode: 'page' | 'width') { fitModeRef.current = mode; setFitMode(mode); refreshFit(); }
    function manualZoom(value: number | ((previous: number) => number)) { fitModeRef.current = 'manual'; setFitMode('manual'); setZoom(value); }
    function togglePanel(panel: 'pages' | 'tools') { if (activePointer.current !== null) cancelInteraction(); setPanels(previous => ({ ...previous, [panel]: !previous[panel] })); }
    function thumbnailPage(current: PageModel) {
        const saved = previewModel.pages.find(page => page.id === current.id);
        if (saved) return saved;
        if (!thumbnailPages.current.has(current.id)) thumbnailPages.current.set(current.id, current);
        return thumbnailPages.current.get(current.id)!;
    }
    useEffect(() => { try { localStorage.setItem('clawdenote-panels-v1', JSON.stringify(panels)); } catch { /* A layout preference is optional. */ } }, [panels]);
    useLayoutEffect(() => {
        const element = viewport.current;
        if (!element) return;
        let frame: number | null = null;
        const observer = new ResizeObserver(() => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; refreshFit(); }); });
        observer.observe(element); refreshFit();
        let previousWidth = window.innerWidth;
        const compact = () => { if (previousWidth >= 900 && window.innerWidth < 900) setPanels({ pages: false, tools: false }); previousWidth = window.innerWidth; };
        window.addEventListener('resize', compact);
        return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); window.removeEventListener('resize', compact); };
    }, [page.id]);
    async function insertImage() { await runTask('Loading image…', async () => { const file = await desktop.open('image'); if (!file)
        return; const type = file.name.toLowerCase().endsWith('.png') ? 'image/png' : file.name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg'; const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(new Blob([new Uint8Array(file.data).buffer], { type })); }); const image = new Image(); image.src = dataUrl; await image.decode(); const w = Math.min(pageRef.current.width * .7, image.naturalWidth); const item: InkItem = { id: uid(), type: 'image', dataUrl, x: 50, y: 50, w, h: w * image.naturalHeight / image.naturalWidth }; await preloadImages([item]); chooseTool('select'); changePage(p => ({ ...p, items: [...p.items, item] })); setSelected(item.id); selectedRef.current = item.id; }); }
    async function exportFile() { setModal(null); await runTask('Exporting ' + exportFormat.toUpperCase() + '…', async () => { const doc = modelRef.current; const current = pageRef.current; let data: string | Uint8Array; let extension: 'pdf' | 'png' | 'jpg' | 'svg'; if (exportFormat === 'pdf') {
        data = await exportPdf(doc);
        extension = 'pdf';
    }
    else if (exportFormat === 'svg') {
        data = await exportPageSvg(doc, current);
        extension = 'svg';
    }
    else {
        extension = exportFormat === 'jpeg' ? 'jpg' : 'png';
        data = await exportPageImage(doc, current, exportFormat === 'jpeg' ? 'jpeg' : 'png', 2);
    } const name = filename(doc.title) + (extension === 'pdf' ? '' : '-page-' + (doc.pages.findIndex(p => p.id === current.id) + 1)) + '.' + extension; const result = await desktop.save(data, { name, extension, saveAs: true }); if (result)
        notify('Exported to ' + result.path); }); }
    async function print() { await runTask('Preparing pages for printing…', async () => { const doc = modelRef.current; const images: string[] = []; for (const p of doc.pages) {
        const bytes = await exportPageImage(doc, p, 'png', 1.5);
        images.push(URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' })));
    } setPrintImages(images); await new Promise(r => setTimeout(r, 200)); await Promise.all([...document.querySelectorAll<HTMLImageElement>('.print-pages img')].map(img => img.decode())); const result = await desktop.print(); if (!result.success && result.reason && !result.reason.toLowerCase().includes('cancel'))
        throw new Error(result.reason); setPrintImages([]); images.forEach(url => URL.revokeObjectURL(url)); }); }
    useEffect(() => { mounted.current = true; scheduleAutosave(); return () => { mounted.current = false; cancelAutosave(); if (toastTimer.current) clearTimeout(toastTimer.current); }; }, []);
    useEffect(() => desktop.onClose(() => {
        if (closingRef.current) return;
        if (busyRef.current) { notify('Finish the current operation before closing.'); return; }
        closingRef.current = true;
        void persistLibrary().then(() => desktop.closeReady()).catch(error => { notify('Could not save changes. Keep this window open and use Save a copy. ' + String(error)); closingRef.current = false; });
    }), []);
    useLayoutEffect(() => { clearSelection(); setEditor(null); setPaper(page.paper); setPaperColor(page.paperColor); pending.current = null; activePointer.current = null; drag.current = null; cancelInkPaint(); hoverPoint.current = null; refreshEraserIndicator(); }, [page.id]);
    useEffect(() => { let valid = true; setPdfReady(false); setBlocks([]); if (tool === 'pdftext' && page.pdf)
        void getPdfTextBlocks(model, page).then(next => { if (valid) {
            setBlocks(next);
            if (!next.length)
                notify('No editable typed text on this page. Scanned pages can still be annotated.');
        } }).catch(error => notify(String(error))); return () => { valid = false; }; }, [tool, page.id, model.pdfSources]);
    useEffect(() => { let valid = true; const render = async () => { const c = bgCanvas.current; if (!c)
        return; const dpr = Math.min(devicePixelRatio || 1, 2); c.width = Math.ceil(page.width * dpr); c.height = Math.ceil(page.height * dpr); const ctx = c.getContext('2d')!; ctx.scale(dpr, dpr); drawPaper(ctx, page); if (page.pdf) {
        const bg = await renderPdfBackground(model, page, Math.max(1.5, zoom * dpr));
        if (valid && bg) {
            ctx.clearRect(0, 0, page.width, page.height);
            ctx.drawImage(bg, 0, 0, page.width, page.height);
        }
    } if (valid)
        setPdfReady(true); }; void render().catch(error => notify(String(error))); return () => { valid = false; }; }, [page.id, page.paper, page.paperColor, page.width, page.height, model.pdfSources, zoom]);
    function inkResolution() { const p = pageRef.current; return Math.min(4, Math.max(1, (devicePixelRatio || 1) * zoomRef.current), 4096 / Math.max(p.width, p.height)); }
    function inkContext(canvas: HTMLCanvasElement) { const p = pageRef.current, scale = inkResolution(); if (canvas.width !== Math.ceil(p.width * scale) || canvas.height !== Math.ceil(p.height * scale)) {
        canvas.width = Math.ceil(p.width * scale);
        canvas.height = Math.ceil(p.height * scale);
    } const context = canvas.getContext('2d')!; context.setTransform(scale, 0, 0, scale, 0, 0); return context; }
    function paintCommitted(items: readonly InkItem[] = pageRef.current.items) { const c = committedCanvas.current; if (!c)
        return; const p = pageRef.current, scale = inkResolution(), last = committedPaint.current; if (last?.pageId === p.id && last.items === items && last.scale === scale)
        return; const ctx = inkContext(c);
        const appendOnly = last?.pageId === p.id && last.scale === scale && last.items.length < items.length && last.items.every((item, index) => item === items[index]);
        if (appendOnly) drawItems(ctx, items.slice(last.items.length));
        else { ctx.clearRect(0, 0, p.width, p.height); drawItems(ctx, items); }
        committedPaint.current = { pageId: p.id, items, scale }; }
    function paintInk(items: readonly InkItem[] = livePreview.current || pageRef.current.items) { const c = inkCanvas.current; if (!c)
        return; const p = pageRef.current; paintCommitted(items); const ctx = inkContext(c); ctx.clearRect(0, 0, p.width, p.height); if (pending.current)
        drawItem(ctx, pending.current); const ids = lassoIdsRef.current.length ? lassoIdsRef.current : selectedRef.current ? [selectedRef.current] : []; const b = ids.length ? getSelectionBounds(livePreview.current || lassoPlan.current?.items || items, ids) : null; if (b) {
        ctx.save();
        ctx.strokeStyle = '#377ba1';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x - 5, b.y - 5, b.w + 10, b.h + 10);
        ctx.restore();
    }
        const polygon = drag.current?.lasso;
        if (polygon?.length) { ctx.save(); ctx.beginPath(); ctx.moveTo(polygon[0].x, polygon[0].y); for (const point of polygon.slice(1)) ctx.lineTo(point.x, point.y); ctx.closePath(); ctx.fillStyle = '#377ba112'; ctx.fill(); ctx.strokeStyle = '#377ba1'; ctx.lineWidth = 1.5 / zoomRef.current; ctx.setLineDash([5 / zoomRef.current, 4 / zoomRef.current]); ctx.stroke(); ctx.restore(); }
    }
    function scheduleInkPaint(items?: readonly InkItem[]) { if (items)
        livePreview.current = items; if (inkFrame.current !== null)
        return; inkFrame.current = requestAnimationFrame(() => { inkFrame.current = null; paintInk(); }); }
    function cancelInkPaint() { if (inkFrame.current !== null)
        cancelAnimationFrame(inkFrame.current); inkFrame.current = null; }
    useEffect(() => subscribeToImageLoads(() => { committedPaint.current = null; scheduleInkPaint(); }), []);
    useEffect(() => () => cancelInkPaint(), []);
    useEffect(() => { let active = true; void preloadImages(page.items).then(() => { if (active)
        paintInk(); }); return () => { active = false; }; }, [page.items, page.width, page.height, selected, lassoIds, zoom]);
    useEffect(() => { const keydown = (e: KeyboardEvent) => { const key = e.key.toLowerCase(); if (busyRef.current)
        return; if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]') || editor || modal)
        return; if (activePointer.current !== null) { if (e.key === 'Escape') { e.preventDefault(); cancelInteraction(); clearSelection(); paintInk(); } return; } if (e.code === 'Space') {
        space.current = true;
        e.preventDefault();
        return;
    } if (e.ctrlKey || e.metaKey) {
        if (key === 'z') {
            e.preventDefault();
            e.shiftKey ? redo() : undo();
        }
        else if (key === 'y') {
            e.preventDefault();
            redo();
        }
        else if (key === 's') {
            e.preventDefault();
            void runTask('Saving notebook…', async () => { await save(e.shiftKey); });
        }
        else if (key === 'o') {
            e.preventDefault();
            void openDocument();
        }
        else if (key === 'p') {
            e.preventDefault();
            void print();
        }
        return;
    } if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = lassoIdsRef.current.length ? lassoIdsRef.current : selectedRef.current ? [selectedRef.current] : [];
        if (ids.length) {
            e.preventDefault();
            const source = lassoPlan.current?.items || pageRef.current.items;
            changePage(p => ({ ...p, items: source.filter(item => !ids.includes(item.id)) }));
            clearSelection();
        }
    }
    else if (e.key === 'Escape') {
        clearSelection(); paintInk();
    }
    else {
        if (activePointer.current !== null) return;
        if (key === 'e') { e.preventDefault(); if (!e.repeat) chooseTool(toolRef.current === 'eraser' ? lastWritingTool.current : 'eraser'); }
        else { const match = TOOLS.find(t => t.key?.toLowerCase() === key); if (match) chooseTool(match.id); }
    } }; const keyup = (e: KeyboardEvent) => { if (e.code === 'Space')
        space.current = false; }; const blur = () => { space.current = false; }; window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur); return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); }; }, [selected, editor, modal, filePath, tool]);
    function position(e: {
        clientX: number;
        clientY: number;
        pressure?: number;
        pointerType?: string;
    }): Point { const rect = drag.current?.rect || inkCanvas.current!.getBoundingClientRect(); return { x: (e.clientX - rect.left) * pageRef.current.width / rect.width, y: (e.clientY - rect.top) * pageRef.current.height / rect.height, pressure: pressure && e.pointerType === 'pen' ? (Number.isFinite(e.pressure) ? Math.max(0, Math.min(1, e.pressure!)) : .5) : .5 }; }
    function refreshEraserIndicator() {
        const indicator = eraserIndicator.current, point = hoverPoint.current, current = pageRef.current;
        if (!indicator) return;
        const visible = toolRef.current === 'eraser' && hoverInside.current && point && point.x >= 0 && point.y >= 0 && point.x <= current.width && point.y <= current.height;
        indicator.style.display = visible ? 'block' : 'none';
        if (point) { indicator.style.left = point.x * zoomRef.current + 'px'; indicator.style.top = point.y * zoomRef.current + 'px'; }
        indicator.style.width = indicator.style.height = eraserSize * zoomRef.current + 'px';
    }
    function updateHover(e: ReactPointerEvent<HTMLCanvasElement>) { hoverPoint.current = position(e); refreshEraserIndicator(); }
    useEffect(() => { refreshEraserIndicator(); }, [tool, zoom, eraserSize]);
    function pointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
        if (busyRef.current || closingRef.current || activePointer.current !== null || (e.button !== 0 && !(e.pointerType === 'pen' && e.button === 5))) return;
        const isEraser = e.pointerType === 'pen' && (e.buttons & 32) !== 0;
        const touchPan = e.pointerType === 'touch' && !touchDraw;
        if (penOnly && e.pointerType !== 'pen') return;
        e.preventDefault(); e.currentTarget.focus({ preventScroll: true });
        drag.current = null; livePreview.current = null;
        const pt = position(e), current = pageRef.current;
        const effective = space.current || touchPan ? 'hand' : isEraser ? 'eraser' : toolRef.current;
        activePointer.current = e.pointerId;
        recordActivity();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { point: pt, latest: pt, clientX: e.clientX, clientY: e.clientY, rect: e.currentTarget.getBoundingClientRect(), before: modelRef.current };
        hoverInside.current = true; updateHover(e);
        if (effective === 'hand') { drag.current.scrollLeft = viewport.current?.scrollLeft || 0; drag.current.scrollTop = viewport.current?.scrollTop || 0; return; }
        if (effective === 'pdftext' || effective === 'text') {
            activePointer.current = null; drag.current = null;
            recordActivity();
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            if (effective === 'pdftext') {
                const block = blocks.find(b => pt.x >= b.x - 3 && pt.x <= b.x + b.w + 3 && pt.y >= b.y - 3 && pt.y <= b.y + b.h + 3);
                if (block) setEditor({ mode: 'pdf', x: block.x, y: block.y, text: block.text, block });
                else notify(current.pdf ? 'Click inside a highlighted text block. Scanned text needs OCR.' : 'Open a PDF to edit its existing text.');
            } else {
                const found = [...current.items].reverse().find(i => i.type === 'text' && hitTest(i, pt.x, pt.y, 5));
                if (found?.type === 'text') setEditor({ mode: 'edit', x: found.x, y: found.y, text: found.text, id: found.id });
                else setEditor({ mode: 'new', x: pt.x, y: pt.y, text: '' });
            }
            return;
        }
        if (effective === 'select') {
            clearSelection();
            const found = [...current.items].reverse().find(i => hitTest(i, pt.x, pt.y, 8 / zoomRef.current));
            setSelected(found?.id || null); selectedRef.current = found?.id || null;
            if (found?.type === 'stroke') setSmoothing(found.smoothing ?? .55);
            drag.current.item = found; scheduleInkPaint(); return;
        }
        if (effective === 'lasso') {
            const source = lassoPlan.current?.items || current.items;
            const bounds = getSelectionBounds(source, lassoIdsRef.current);
            if (bounds && pt.x >= bounds.x - 6 && pt.x <= bounds.x + bounds.w + 6 && pt.y >= bounds.y - 6 && pt.y <= bounds.y + bounds.h + 6) {
                drag.current.group = { items: source, ids: [...lassoIdsRef.current] };
            } else { clearSelection(); drag.current.lasso = [pt]; }
            scheduleInkPaint(); return;
        }
        clearSelection();
        if (effective === 'eraser') {
            drag.current.eraseItems = eraseInkPath(current.items, pt, pt, eraserSize / 2);
            drag.current.eraseLast = pt; scheduleInkPaint(drag.current.eraseItems); return;
        }
        if (effective === 'pen' || effective === 'highlighter') pending.current = { id: uid(), type: 'stroke', tool: effective, color, width: effective === 'highlighter' ? Math.max(12, width * 5) : width, smoothing, points: [pt] };
        else if (['line', 'arrow', 'rectangle', 'ellipse'].includes(effective)) pending.current = { id: uid(), type: 'shape', shape: effective as 'line' | 'arrow' | 'rectangle' | 'ellipse', color, width, x: pt.x, y: pt.y, w: 0, h: 0 };
        paintInk();
    }
    function pointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
        updateHover(e);
        if (activePointer.current !== e.pointerId || !drag.current) return;
        recordActivity();
        e.preventDefault(); const d = drag.current; d.latest = position(e);
        if (d.scrollLeft !== undefined) {
            if (viewport.current) { viewport.current.scrollLeft = d.scrollLeft - (e.clientX - d.clientX); viewport.current.scrollTop = (d.scrollTop || 0) - (e.clientY - d.clientY); }
            return;
        }
        const pt = position(e);
        if (d.eraseItems) {
            const batch = e.nativeEvent.getCoalescedEvents?.();
            for (const sample of batch?.length ? batch : [e.nativeEvent]) { const point = position(sample); d.eraseItems = eraseInkPath(d.eraseItems, d.eraseLast!, point, eraserSize / 2); d.eraseLast = point; }
            scheduleInkPaint(d.eraseItems); return;
        }
        if (d.lasso) { if (Math.hypot(pt.x - d.lasso.at(-1)!.x, pt.y - d.lasso.at(-1)!.y) > 2 / zoomRef.current) d.lasso.push(pt); scheduleInkPaint(); return; }
        if (d.group || d.item) {
            const dx = pt.x - d.point.x, dy = pt.y - d.point.y;
            d.changed = Math.hypot(dx, dy) > 1;
            const source = d.group?.items || pageRef.current.items;
            const ids = d.group?.ids || [d.item!.id];
            scheduleInkPaint(source.map(i => ids.includes(i.id) ? translateItem(i, dx, dy) : i)); return;
        }
        if (pending.current?.type === 'stroke') {
            const batch = e.nativeEvent.getCoalescedEvents?.();
            for (const sample of batch?.length ? batch : [e.nativeEvent]) {
                const point = position(sample), last = pending.current.points.at(-1)!;
                if (Math.hypot(point.x - last.x, point.y - last.y) > .05 || Math.abs(point.pressure - last.pressure) > .02) pending.current.points.push(point);
            }
        } else if (pending.current?.type === 'shape') { pending.current.w = pt.x - d.point.x; pending.current.h = pt.y - d.point.y; }
        scheduleInkPaint();
    }
    function pointerUp(e: ReactPointerEvent<HTMLCanvasElement>) { if (activePointer.current === e.pointerId) completeInteraction(position(e), e.pointerType === 'pen'); }
    function completeInteraction(point: Point, penLift = false) {
        const pointerId = activePointer.current; if (pointerId === null) return;
        cancelInkPaint();
        const d = drag.current, item = pending.current, pt = { ...point };
        if (item?.type === 'stroke') { const last = item.points.at(-1)!; if (penLift && pt.pressure === 0) pt.pressure = last.pressure; if (Math.hypot(pt.x - last.x, pt.y - last.y) > .05) item.points.push(pt); }
        else if (item?.type === 'shape' && d) { item.w = pt.x - d.point.x; item.h = pt.y - d.point.y; }
        if (d?.eraseItems) d.eraseItems = eraseInkPath(d.eraseItems, d.eraseLast!, pt, eraserSize / 2);
        pending.current = null; activePointer.current = null; drag.current = null; livePreview.current = null;
        if (inkCanvas.current?.hasPointerCapture(pointerId)) inkCanvas.current.releasePointerCapture(pointerId);
        if (d?.eraseItems && d.eraseItems !== pageRef.current.items) changePage(p => ({ ...p, items: [...d.eraseItems!] }));
        else if (d?.lasso) {
            d.lasso.push(pt);
            const selection = selectWithinLasso(pageRef.current.items, d.lasso);
            lassoPlan.current = selection.selectedIds.length ? { original: pageRef.current.items, ...selection } : null;
            lassoIdsRef.current = selection.selectedIds; setLassoIds(selection.selectedIds);
            selectedRef.current = selection.selectedIds.length === 1 ? selection.selectedIds[0] : null; setSelected(selectedRef.current);
        } else if (d?.group || d?.item) {
            const dx = pt.x - d.point.x, dy = pt.y - d.point.y;
            if (Math.hypot(dx, dy) > 1) {
                const source = d.group?.items || pageRef.current.items, ids = d.group?.ids || [d.item!.id];
                changePage(p => ({ ...p, items: source.map(i => ids.includes(i.id) ? translateItem(i, dx, dy) : i) }));
                lassoPlan.current = null;
                if (d.group) { lassoIdsRef.current = ids; setLassoIds(ids); selectedRef.current = ids.length === 1 ? ids[0] : null; setSelected(selectedRef.current); }
            }
        } else if (item && (item.type !== 'shape' || Math.abs(item.w) + Math.abs(item.h) > 2)) changePage(p => ({ ...p, items: [...p.items, item] }));
        const nextPage = modelRef.current.pages.find(p => p.id === pageRef.current.id);
        paintInk(nextPage?.items || pageRef.current.items);
        recordActivity();
        if (fitPending.current) refreshFit();
    }
    function cancelInteraction() {
        const pointer = activePointer.current;
        cancelInkPaint(); pending.current = null; activePointer.current = null; drag.current = null; livePreview.current = null;
        if (pointer !== null && inkCanvas.current?.hasPointerCapture(pointer)) inkCanvas.current.releasePointerCapture(pointer);
        paintInk();
        if (pointer !== null) recordActivity();
        if (fitPending.current) refreshFit();
    }
    function pointerCancel(e: ReactPointerEvent<HTMLCanvasElement>) { if (activePointer.current === e.pointerId) cancelInteraction(); }
    function pointerCaptureLost(e: ReactPointerEvent<HTMLCanvasElement>) {
        // Windows can release capture without delivering the final pen-up event.
        // Keep the ink already drawn; an explicit cancellation still rolls back.
        if (activePointer.current === e.pointerId && drag.current) completeInteraction(drag.current.latest);
    }
    function updateSmoothing(value: number) {
        setSmoothing(value);
        const source = lassoPlan.current?.items || pageRef.current.items;
        const ids = lassoIdsRef.current.length ? lassoIdsRef.current : selectedRef.current ? [selectedRef.current] : [];
        if (source.some(i => ids.includes(i.id) && i.type === 'stroke')) { changePage(p => ({ ...p, items: source.map(i => ids.includes(i.id) && i.type === 'stroke' ? { ...i, smoothing: value } : i) })); lassoPlan.current = null; lassoIdsRef.current = ids; setLassoIds(ids); selectedRef.current = ids.length === 1 ? ids[0] : null; setSelected(selectedRef.current); }
    }
    async function applyEditor() { if (!editor)
        return; const value = editor.text; if (!value.trim() && editor.mode !== 'pdf')
        return; const edit = editor; if (edit.mode === 'pdf') {
        await runTask('Replacing original PDF text…', async () => { const next = structuredClone(modelRef.current); const p = next.pages.find(p => p.id === pageRef.current.id)!; await replacePdfText(next, p, edit.block!, value); updateModel(next); setEditor(null); notify('Original PDF text replaced. Undo is available.'); });
    }
    else {
        changePage(p => ({ ...p, items: edit.mode === 'edit' ? p.items.map(i => i.id === edit.id && i.type === 'text' ? { ...i, text: value } : i) : [...p.items, { id: uid(), type: 'text', x: edit.x, y: edit.y, text: value, color, fontSize }] }));
        setEditor(null);
    } }
    const pageNumber = model.pages.findIndex(p => p.id === page.id) + 1;
    void historyVersion;
    void pdfReady;
    return <div className={`app-shell${panels.pages ? '' : ' pages-collapsed'}${panels.tools ? '' : ' tools-collapsed'}`}>
  <header className="topbar"><div className="brand"><div className="brand-icon"><PenLine size={23}/></div><div><strong>Clawdenote<span>.</span></strong><small>A little space to think</small></div></div><div className="document-heading"><input aria-label="Notebook name" value={model.title} maxLength={120} onChange={e => updateModel({ ...modelRef.current, title: e.target.value })}/><span className="save-indicator" role="status" aria-live="polite"><span className={saveStatus === 'Save failed' ? 'warning-dot' : 'status-dot'}/>{saveStatus}</span></div><div className="file-actions"><button onClick={() => void goHome()} aria-label="Home" title="Home"><Home size={17}/><span className="file-action-label">Home</span></button><button onClick={() => void newNotebook()} aria-label="New notebook" title="New notebook"><BookOpen size={17}/><span className="file-action-label">New</span></button><button onClick={() => void openDocument()} aria-label="Open" title="Open"><FolderOpen size={17}/><span className="file-action-label">Open</span></button><button onClick={() => void runTask('Saving notebook…', async () => { await save(); })} aria-label="Save notebook" title="Save notebook"><Save size={17}/><span className="file-action-label">Save</span>{dirty && <i />}</button><button className="primary" onClick={() => setModal('export')} aria-label="Export" title="Export"><Download size={17}/><span className="file-action-label">Export</span><ChevronDown size={15}/></button></div></header>
  <div className="toolstrip"><div className="tools">{TOOLS.map(({ id, label, icon: Icon, key }) => <button key={id} className={`tool ${tool === id ? 'active' : ''}`} onClick={() => chooseTool(id)} aria-label={label} aria-pressed={tool === id} title={label + (key ? ' (' + key + ')' : '')}><Icon size={20}/><span>{id === 'pdftext' ? 'PDF text' : label.replace(' & move', '')}</span></button>)}</div><div className="toolstrip-end"><button className="icon-button sidebar-toggle" aria-label={panels.pages ? 'Hide pages' : 'Show pages'} title={panels.pages ? 'Hide pages' : 'Show pages'} aria-expanded={panels.pages} aria-controls="pages-panel" onClick={() => togglePanel('pages')}>{panels.pages ? <PanelLeftClose size={19}/> : <PanelLeftOpen size={19}/>}</button><button className="icon-button sidebar-toggle" aria-label={panels.tools ? 'Hide tools' : 'Show tools'} title={panels.tools ? 'Hide tools' : 'Show tools'} aria-expanded={panels.tools} aria-controls="tools-panel" onClick={() => togglePanel('tools')}>{panels.tools ? <PanelRightClose size={19}/> : <PanelRightOpen size={19}/>}</button><span className="divider"/><IconButton label="Undo" disabled={!history.current.past.length} onClick={undo}><Undo2 size={19}/></IconButton><IconButton label="Redo" disabled={!history.current.future.length} onClick={redo}><Redo2 size={19}/></IconButton><span className="divider"/><IconButton label="Insert image" onClick={() => void insertImage()}><ImagePlus size={19}/></IconButton><IconButton label="Print notebook" onClick={() => void print()}><Printer size={19}/></IconButton><IconButton label="Help & shortcuts" onClick={() => setModal('help')}><HelpCircle size={19}/></IconButton></div></div>
  <div className="body-layout">{panels.pages && <aside className="sidebar" id="pages-panel"><div className="sidebar-heading"><span><Layers size={16}/>YOUR PAGES</span><span className="count">{model.pages.length}</span></div><div className="page-list">{model.pages.map((p, index) => <button className={`page-card ${p.id === page.id ? 'current' : ''}`} key={p.id} onClick={() => selectPage(p.id)} aria-label={`Page ${index + 1}`} aria-current={p.id === page.id ? 'page' : undefined}><div className="thumbnail"><Thumbnail model={previewModel} page={thumbnailPage(p)} interaction={activePointer} activity={lastActivity}/>{p.id === page.id && <span className="page-check"><Check size={12}/></span>}</div><div className="page-card-label"><strong>{p.label || 'Page ' + (index + 1)}</strong><span>{p.pdf ? 'PDF document' : paperNames[p.paper] + ' · A4'}</span></div></button>)}</div><div className="page-actions"><button className="add-page" onClick={addPage} aria-label="Add page"><Plus size={17}/>Add page</button><div className="page-mini-actions"><IconButton label="Duplicate page" onClick={duplicatePage}><Copy size={16}/></IconButton><IconButton label="Move page up" disabled={pageNumber === 1} onClick={() => movePage(-1)}><ChevronUp size={18}/></IconButton><IconButton label="Move page down" disabled={pageNumber === model.pages.length} onClick={() => movePage(1)}><ChevronDown size={18}/></IconButton><IconButton label="Delete page" disabled={model.pages.length === 1} onClick={() => setModal('delete')}><Trash2 size={16}/></IconButton></div><button className="import-pdf" onClick={() => void appendPdf()}><FolderOpen size={15}/>Add PDF pages<Plus size={13}/></button></div><div className="local-note"><ShieldCheck size={17}/><div><strong>Yours, on your laptop.</strong><span>No account. No cloud required.</span></div></div></aside>}
  <main className="workspace"><div className="workspace-top"><div className="workspace-copy"><span className="notebook-tag">{page.pdf ? 'PDF WORKSPACE' : 'YOUR NOTEBOOK'}</span><span className="workspace-name">{page.pdf ? 'Write, mark up, or edit text' : 'A fresh page. A clear mind.'}</span></div><div className="zoom-control"><IconButton label="Zoom out" onClick={() => manualZoom(z => Math.max(.1, z - .1))}><ZoomOut size={16}/></IconButton><button className="zoom-value" onClick={() => manualZoom(1)} title="Actual size">{Math.round(zoom * 100)}%</button><IconButton label="Zoom in" onClick={() => manualZoom(z => Math.min(3, z + .1))}><ZoomIn size={16}/></IconButton><span className="divider"/><IconButton label="Fit width" active={fitMode === 'width'} onClick={() => fit('width')}><MoveHorizontal size={16}/></IconButton><IconButton label="Fit page" active={fitMode === 'page'} onClick={() => fit('page')}><Maximize size={15}/></IconButton></div></div>
   <div className="paper-viewport" ref={viewport} onWheel={e => { if (e.ctrlKey) {
        e.preventDefault();
        manualZoom(z => Math.min(3, Math.max(.1, z - e.deltaY * .002)));
    } }}><div className="page-wrap" style={{ width: page.width * zoom, height: page.height * zoom }}><div className="paper-stage" style={{ width: page.width * zoom, height: page.height * zoom }}><canvas ref={bgCanvas} className="paper-background"/><canvas ref={committedCanvas} className="committed-ink"/><canvas ref={inkCanvas} className={`ink-canvas cursor-${tool}`} data-testid="drawing-surface" aria-label="Writing page" tabIndex={0} onPointerEnter={e => { hoverInside.current = true; updateHover(e); }} onPointerLeave={() => { hoverInside.current = false; refreshEraserIndicator(); }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={pointerCaptureLost} style={{ touchAction: 'none', cursor: tool === 'eraser' ? 'none' : tool === 'pen' || tool === 'highlighter' ? inkDotCursor(color) : undefined }}/><div ref={eraserIndicator} data-testid="eraser-indicator" className="eraser-indicator" aria-hidden="true"/>{tool === 'pdftext' && blocks.map(block => <div key={block.id} className="pdf-text-block" style={{ left: block.x * zoom, top: block.y * zoom, width: block.w * zoom, height: block.h * zoom }} aria-hidden="true"/>)}<span className="paper-corner"/></div><div className="page-caption"><span>{page.pdf ? 'PDF page' : paperNames[page.paper] + ' paper'}</span><span>{page.pdf ? 'Original page size' : '210 × 297 mm · A4'}</span></div></div></div>
   <div className="workspace-footer"><span><span className="status-dot"/> {penOnly ? 'Pen input only' : touchDraw ? 'Pen, mouse & touch' : 'Pen & mouse · touch to scroll'}</span><span>Page {pageNumber} of {model.pages.length}<span className="footer-divider">/</span>{TOOLS.find(t => t.id === tool)?.label}<span className="footer-divider">/</span>Hold Space to pan</span></div>
  </main>
  {panels.tools && <aside className="properties" id="tools-panel"><div className="panel-title">MAKE IT YOURS</div><section><h3>Ink colour <span className="color-preview" style={{ background: color }}/></h3><div className="color-grid">{COLORS.map(c => <button key={c} className={`color-swatch ${c === color ? 'selected' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={'Colour ' + c} title={c}>{c === color && <Check size={15} color={c === '#ffffff' || c === '#f2cc57' ? '#27352f' : '#fff'}/>}</button>)}<label className="custom-colour" title="Choose any colour"><Plus size={15}/><input type="color" aria-label="Custom colour" value={color} onChange={e => setColor(e.target.value)}/></label></div><div className="field-label"><label htmlFor="ink-width">{tool === 'eraser' ? 'Eraser size' : 'Stroke width'}</label><span>{tool === 'eraser' ? eraserSize : width} px</span></div><input id="ink-width" aria-label={tool === 'eraser' ? 'Eraser size' : 'Stroke width'} type="range" min={tool === 'eraser' ? 6 : 1} max={tool === 'eraser' ? 100 : 12} step={tool === 'eraser' ? 2 : .5} value={tool === 'eraser' ? eraserSize : width} onChange={e => tool === 'eraser' ? setEraserSize(Number(e.target.value)) : setWidth(Number(e.target.value))}/><div className="stroke-preview"><svg width="150" height="35" viewBox="0 0 150 35"><path d="M 10 25 C 35 3, 50 5, 66 18 S 108 34, 140 10" stroke={color === '#ffffff' ? '#d9d9d9' : color} strokeWidth={width} fill="none" strokeLinecap="round"/></svg></div><div className="field-label"><label htmlFor="ink-smoothing">Ink smoothing</label><span>{Math.round(smoothing * 100)}%</span></div><input id="ink-smoothing" aria-label="Ink smoothing" type="range" min="0" max="100" step="5" value={Math.round(smoothing * 100)} onChange={e => updateSmoothing(Number(e.target.value) / 100)}/><p className="tiny-note">{selected ? 'Smooths the selected ink stroke.' : 'Smooths new strokes. Start at 55%.'}</p><label className="toggle-row"><span>Pressure sensitivity</span><input type="checkbox" checked={pressure} onChange={e => setPressure(e.target.checked)}/></label><label className="toggle-row"><span>Pen only / palm rejection</span><input type="checkbox" checked={penOnly} onChange={e => setPenOnly(e.target.checked)}/></label><label className="toggle-row"><span>Draw with touch</span><input type="checkbox" checked={touchDraw} onChange={e => setTouchDraw(e.target.checked)}/></label></section>
   <section><h3>Paper style <span>A4</span></h3><div className="paper-options">{(['blank', 'lined', 'graph', 'dot'] as const).map(p => <button key={p} aria-label={`${paperNames[p]} paper`} aria-pressed={paper === p} className={`paper-option ${paper === p ? 'selected' : ''}`} onClick={() => { setPaper(p); if (!page.pdf)
        changePage(current => ({ ...current, paper: p })); }}><span className={'paper-sample ' + p}/><span>{paperNames[p]}</span></button>)}</div><p className="tiny-note">{page.pdf ? 'Style applies to new pages. PDF pages keep their original layout.' : 'Applies to this page and the next one you add.'}</p><div className="paper-tints"><span>Paper tone</span>{['#ffffff', '#fffdf5', '#edf4ee'].map(c => <button key={c} aria-label={'Paper tone ' + c} style={{ background: c }} className={paperColor === c ? 'selected' : ''} onClick={() => { setPaperColor(c); if (!page.pdf)
        changePage(p => ({ ...p, paperColor: c })); }}/>)}</div></section>
   <section><h3>Text size <span>{fontSize} pt</span></h3><input aria-label="Text size" type="range" min="10" max="64" value={fontSize} onChange={e => setFontSize(Number(e.target.value))}/><button className="panel-link" onClick={() => void runTask('Saving notebook…', async () => { await save(true); })}><Save size={14}/>Save a copy…<ChevronRight size={13}/></button><button className="panel-link" onClick={() => setModal('clear')} disabled={!page.items.length}><Eraser size={14}/>Clear page annotations</button></section><div className="writing-tip"><PenLine size={20}/><strong>{tool === 'lasso' ? 'Give your thoughts some room.' : 'Follow your train of thought.'}</strong><p>{tool === 'lasso' ? 'Circle part of your notes, then drag inside the selection to move it. Press Escape to deselect.' : 'Connect your pen tablet, pick a colour, and start writing. Your notebook saves when you pause.'}</p></div>
  </aside>}</div>
  {toast && <div className="toast" role="status"><Check size={17}/><span>{toast}</span><IconButton label="Dismiss notification" onClick={() => setToast('')}><X size={14}/></IconButton></div>}
  {busy && <div className="busy-overlay" role="status"><span className="spinner"/>{busy}</div>}
  {editor && <Modal title={editor.mode === 'pdf' ? 'Edit original PDF text' : editor.mode === 'edit' ? 'Edit text' : 'Add text'} onClose={() => setEditor(null)}><p className="modal-description">{editor.mode === 'pdf' ? 'Replace the text in this block. The original text will be removed from the PDF. Font appearance may change; replacement stays inside the selected block.' : 'Type your note. Use Select & move to position it on the page.'}</p><textarea autoFocus aria-label={editor.mode === 'pdf' ? 'Replacement text' : 'Note text'} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} rows={6}/><div className="modal-actions"><button onClick={() => setEditor(null)}>Cancel</button><button className="primary" onClick={() => void applyEditor()}>{editor.mode === 'pdf' ? 'Apply replacement' : 'Add text'}</button></div></Modal>}
  {modal === 'export' && <Modal title="Take your work with you" onClose={() => setModal(null)}><p className="modal-description">Your notebook saves automatically to your library. Choose a format to export a separate copy.</p><label className="form-label" htmlFor="export-format">Export format</label><select id="export-format" aria-label="Export format" value={exportFormat} onChange={e => setExportFormat(e.target.value)}><option value="pdf">PDF — all pages</option><option value="png">PNG — current page, high resolution</option><option value="jpeg">JPEG — current page, high resolution</option><option value="svg">SVG — current page</option></select><div className="export-note"><Download size={22}/><p>{exportFormat === 'pdf' ? 'All paper and PDF pages, with your writing and edits. Original PDF content stays searchable.' : 'Exports page ' + pageNumber + ' with its paper, PDF content, and annotations.'}</p></div><div className="modal-actions"><button onClick={() => setModal(null)}>Cancel</button><button className="primary" onClick={() => void exportFile()} aria-label="Export file"><Download size={16}/>Choose location & export</button></div></Modal>}
  {modal === 'delete' && <Modal title="Delete this page?" onClose={() => setModal(null)}><p className="modal-description">Page {pageNumber} and its annotations will be removed. You can restore it with Undo.</p><div className="modal-actions"><button onClick={() => setModal(null)}>Keep page</button><button className="danger" onClick={deletePage}>Delete page</button></div></Modal>}
  {modal === 'clear' && <Modal title="Clear page annotations?" onClose={() => setModal(null)}><p className="modal-description">Remove handwriting, shapes, images, and added text from this page. PDF text edits remain in the source document. Undo can restore the annotations.</p><div className="modal-actions"><button onClick={() => setModal(null)}>Cancel</button><button className="danger" onClick={() => { changePage(p => ({ ...p, items: [] })); setModal(null); }}>Clear annotations</button></div></Modal>}
  {modal === 'help' && <Modal title="A few things to know" onClose={() => setModal(null)}><div className="help-content"><p><b>Pen & tablet.</b> Your Windows tablet driver must support Windows Ink. Turn on Pen only to reject mouse and palm input. Pen pressure works on compatible devices. Start with Ink smoothing at 55%; increase it for steadier curves or lower it for sharper small letters. Select a stroke to adjust its smoothing.</p><p><b>Eraser.</b> The round eraser removes sections of handwriting along its path. Shapes, images, and added text erase as whole items. Press E again to return to your previous pen or highlighter.</p><p><b>More writing space.</b> Use the two panel buttons beside Undo to hide or show pages and tools. Fit width keeps the paper fitted as you resize the window; zooming manually keeps your chosen size.</p><p><b>PDF text.</b> Pick Edit PDF text, then click an outlined block. Replacement uses a standard font and may shrink to fit. Scans need OCR, which this version does not include. Duplicated PDF pages can be edited independently.</p><p><b>Lasso select.</b> Press Q and circle the ink you want. Drag inside the selection to move it, or press Delete to remove it. You can select just part of a stroke. Escape clears the selection; Undo restores a move.</p><p><b>Your library.</b> Notes save automatically after you pause writing and before closing. Home shows your recent notebooks with search, rename, and delete. Deleted notes can be restored. Save a copy creates an editable .clawdenote backup; PDF/PNG/JPEG/SVG are exports.</p><div className="shortcuts"><span>Undo / redo<kbd>Ctrl Z / Ctrl Shift Z</kbd></span><span>Save / save a copy<kbd>Ctrl S / Ctrl Shift S</kbd></span><span>Open / print<kbd>Ctrl O / Ctrl P</kbd></span><span>Pen / highlight / erase<kbd>P / H / E</kbd></span><span>Select / lasso / text<kbd>V / Q / T</kbd></span><span>Delete selection<kbd>Delete</kbd></span></div><p className="tiny-note">Clawdenote {appVersion} · Local and open source. Built with Electron, React, and MuPDF. Licensed under AGPL v3; source is supplied with this app.</p></div><div className="modal-actions"><button className="primary" onClick={() => setModal(null)}>Got it</button></div></Modal>}
  <div className="print-pages">{printImages.map((url, i) => <div key={url}><img src={url} alt={'Page ' + (i + 1)}/></div>)}</div>
 </div>;
}
