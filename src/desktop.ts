export interface OpenResult {name:string;path?:string;data:Uint8Array}
export interface SaveOptions {name:string;extension:'clawdenote'|'inkstone'|'pdf'|'png'|'jpg'|'svg';saveAs?:boolean;currentPath?:string}
export interface DesktopBridge {
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
export const desktop:DesktopBridge = window.desktop || {
 open:browserOpen,
 save:async(data,options)=>{const blob=new Blob([typeof data==='string'?data:new Uint8Array(data).buffer]);const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=options.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return {path:'Downloads/'+options.name,name:options.name}},
 autosave:async data=>{localStorage.setItem('inkstone-recovery',data)},
 recovery:async()=>localStorage.getItem('inkstone-recovery'),
 print:async()=>{window.print();return {success:true}},
 onClose:()=>()=>{},closeReady:()=>{},confirmClose:async()=>2
};
