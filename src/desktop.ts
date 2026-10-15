export interface OpenResult {name:string;path?:string;data:Uint8Array}
export interface SaveOptions {name:string;extension:'clawdenote'|'inkstone'|'pdf'|'png'|'jpg'|'svg';saveAs?:boolean;currentPath?:string}
export interface DesktopBridge {
 libraryList(includeDeleted?:boolean):Promise<LibraryEntry[]>;
 libraryRead(id:string):Promise<LibraryReadResult>;
 librarySave(id:string|null,data:string,previewDataUrl?:string):Promise<LibraryEntry>;
 libraryImport(data:string,sourcePath?:string,previewDataUrl?:string):Promise<LibraryImportResult>;
 libraryDelete(id:string):Promise<void>;
 libraryRestore(id:string):Promise<LibraryEntry>;
 open(kind:'document'|'pdf'|'image'):Promise<OpenResult|null>;
 save(data:string|Uint8Array,options:SaveOptions):Promise<{path:string;name:string}|null>;
 autosave(data:string):Promise<void>;
 recovery():Promise<string|null>;
 print():Promise<{success:boolean;reason?:string}>;
 onClose(cb:()=>void):()=>void;
 closeReady():void;
 confirmClose():Promise<number>;
}
declare global {interface Window {desktop?:DesktopBridge}}
function browserOpen(kind:string):Promise<OpenResult|null> {
 return new Promise(resolve => {const input=document.createElement('input');input.type='file';input.accept=kind==='image'?'image/png,image/jpeg,image/webp':kind==='pdf'?'.pdf':'.pdf,.clawdenote,.inkstone';input.onchange=async()=>{const f=input.files?.[0];resolve(f?{name:f.name,data:new Uint8Array(await f.arrayBuffer())}:null)};input.oncancel=()=>resolve(null);input.click();});
}
interface BrowserNote {entry:LibraryEntry;data:string;documentId:string}
interface BrowserLibrary {version:1;migrated:boolean;notes:Record<string,BrowserNote>}
const LIBRARY_KEY='clawdenote-library-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function browserId(id:string){if(typeof id!=='string'||!UUID.test(id))throw new Error('Invalid notebook ID.');return id.toLowerCase()}
function browserDocument(data:string){if(typeof data!=='string'||data.length>300*1024*1024)throw new Error('Invalid notebook data.');return validateDocument(JSON.parse(data))}
function browserPreview(value?:string){if(value===undefined)return undefined;if(typeof value!=='string')throw new Error('Invalid notebook preview.');if(value.length>350_000)return undefined;if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value))throw new Error('Invalid notebook preview.');return value}
function browserSource(value?:string){if(value!==undefined&&(typeof value!=='string'||!value||value.length>4096||value.includes('\0')))throw new Error('Invalid notebook source path.');return value}
function browserSourceKey(value?:string){return value?.replace(/\\/g,'/').toLowerCase()}
function browserWrite(state:BrowserLibrary){localStorage.setItem(LIBRARY_KEY,JSON.stringify(state))}
function browserState():BrowserLibrary {
 const raw=localStorage.getItem(LIBRARY_KEY);let state:BrowserLibrary;
 if(raw){state=JSON.parse(raw) as BrowserLibrary;if(state.version!==1||!state.notes||typeof state.notes!=='object'||Array.isArray(state.notes))throw new Error('The browser notebook library could not be read. Its stored data has been preserved.')}
 else state={version:1,migrated:false,notes:{}};
 if(!state.migrated){const recovery=localStorage.getItem('inkstone-recovery');if(recovery){try{const document=browserDocument(recovery);const meaningful=!/^(?:untitled(?: notebook)?|new notebook)?$/i.test(document.title.trim())||document.pages.length>1||document.pages.some(page=>page.items.length||page.pdf||page.paper!=='blank'||!['#fff','#ffffff'].includes(page.paperColor.toLowerCase()));if(meaningful&&!Object.values(state.notes).some(note=>note?.documentId===document.id)){const now=new Date().toISOString(),id=crypto.randomUUID();state.notes[id]={entry:{id,title:document.title,createdAt:now,updatedAt:now,lastOpenedAt:now,pageCount:document.pages.length},data:recovery,documentId:document.id}}}catch{/* Leave an unreadable legacy recovery untouched. */}}state.migrated=true;browserWrite(state)}
 return state;
}
let browserQueue:Promise<unknown>=Promise.resolve();
function browserRun<T>(work:(state:BrowserLibrary)=>T):Promise<T>{const operation=browserQueue.then(()=>work(browserState()));browserQueue=operation.catch(()=>{});return operation}
function browserFind(state:BrowserLibrary,id:string,deleted=false):BrowserNote{const note=state.notes[browserId(id)];if(!note?.entry||Boolean(note.entry.deletedAt)!==deleted)throw new Error(deleted?'This notebook is no longer in Trash.':'This notebook is missing or is in Trash.');return note}
function browserEntry(id:string,note:BrowserNote):LibraryEntry {
 const now=new Date().toISOString();const entry=note?.entry&&typeof note.entry.title==='string'?note.entry:{id,title:'Unreadable notebook',createdAt:now,updatedAt:now,lastOpenedAt:now,pageCount:0};
 try{const document=browserDocument(note?.data);return {...entry,id,title:document.title,pageCount:document.pages.length}}catch{return {...entry,id,error:'This notebook could not be read. Its stored data has been preserved.'}}
}
function browserStore(state:BrowserLibrary,id:string|null,data:string,previewDataUrl?:string):BrowserNote{
 const document=browserDocument(data),image=browserPreview(previewDataUrl),now=new Date().toISOString();const previous=id===null?undefined:browserFind(state,id);const noteId=previous?.entry.id||crypto.randomUUID();
 const note:BrowserNote={entry:{id:noteId,title:document.title,createdAt:previous?.entry.createdAt||now,updatedAt:now,lastOpenedAt:previous?.entry.lastOpenedAt||now,pageCount:document.pages.length,...(previous?.entry.previewDataUrl?{previewDataUrl:previous.entry.previewDataUrl}:{}),...(image?{previewDataUrl:image}:{}),...(previous?.entry.sourcePath?{sourcePath:previous.entry.sourcePath}:{})},data,documentId:document.id};state.notes[noteId]=note;return note;
}
const browserLibrary={
 libraryList:(includeDeleted=false)=>browserRun(state=>{if(typeof includeDeleted!=='boolean')throw new Error('Invalid library listing request.');return Object.entries(state.notes).filter(([id])=>UUID.test(id)).map(([id,note])=>browserEntry(id,note)).filter(entry=>includeDeleted||!entry.deletedAt).sort((a,b)=>Math.max(Date.parse(b.updatedAt),Date.parse(b.lastOpenedAt))-Math.max(Date.parse(a.updatedAt),Date.parse(a.lastOpenedAt))||a.id.localeCompare(b.id))}),
 libraryRead:(id:string)=>browserRun(state=>{const note=browserFind(state,id);browserDocument(note.data);note.entry.lastOpenedAt=new Date().toISOString();browserWrite(state);return {entry:note.entry,data:note.data}}),
 librarySave:(id:string|null,data:string,previewDataUrl?:string)=>browserRun(state=>{const note=browserStore(state,id,data,previewDataUrl);browserWrite(state);return note.entry}),
 libraryImport:(data:string,sourcePath?:string,previewDataUrl?:string)=>browserRun(state=>{const document=browserDocument(data);browserSource(sourcePath);browserPreview(previewDataUrl);const existing=Object.values(state.notes).find(note=>sourcePath&&browserSourceKey(note?.entry?.sourcePath)===browserSourceKey(sourcePath))||Object.values(state.notes).find(note=>note?.documentId===document.id);if(existing){browserDocument(existing.data);delete existing.entry.deletedAt;existing.entry.lastOpenedAt=new Date().toISOString();if(!existing.entry.sourcePath&&sourcePath)existing.entry.sourcePath=sourcePath;browserWrite(state);return {entry:existing.entry,data:existing.data,imported:false}}const note=browserStore(state,null,data,previewDataUrl);if(sourcePath)note.entry.sourcePath=sourcePath;browserWrite(state);return {entry:note.entry,data:note.data,imported:true}}),
 libraryDelete:(id:string)=>browserRun(state=>{browserFind(state,id).entry.deletedAt=new Date().toISOString();browserWrite(state)}),
 libraryRestore:(id:string)=>browserRun(state=>{const note=browserFind(state,id,true);delete note.entry.deletedAt;note.entry.lastOpenedAt=new Date().toISOString();browserWrite(state);return note.entry}),
};
export const desktop:DesktopBridge = window.desktop || {
 ...browserLibrary,
 open:browserOpen,
 save:async(data,options)=>{const blob=new Blob([typeof data==='string'?data:new Uint8Array(data).buffer]);const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=options.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return {path:'Downloads/'+options.name,name:options.name}},
 autosave:async data=>{localStorage.setItem('inkstone-recovery',data)},
 recovery:async()=>localStorage.getItem('inkstone-recovery'),
 print:async()=>{window.print();return {success:true}},
 onClose:()=>()=>{},closeReady:()=>{},confirmClose:async()=>2
};
import type { LibraryEntry, LibraryImportResult, LibraryReadResult } from './library';
import { validateDocument } from './model';

