const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Keep the original data directory so a branding update preserves recovery.
app.setPath('userData',process.env.CLAWDENOTE_USER_DATA || process.env.INKSTONE_USER_DATA || path.join(app.getPath('appData'),'inkstone'));
app.setName('Clawdenote');
let win;
let closing = false;
const notebookPaths = new Set();
let recoveryQueue = Promise.resolve();
let fileSaveQueue = Promise.resolve();
const FILTERS = {
  document: [{name:'Notebooks & PDF documents',extensions:['clawdenote','inkstone','pdf']}],
  pdf: [{name:'PDF documents',extensions:['pdf']}],
  image: [{name:'Images',extensions:['png','jpg','jpeg','webp']}]
};
app.setAppUserModelId('local.inkstone.notebook');
function localSender(event) { if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted request'); }
function register(name, handler) { ipcMain.handle(name, (event, ...args) => { localSender(event); return handler(...args); }); }
const recoveryPath = () => path.join(app.getPath('userData'), 'recovery.inkstone');
async function atomicWrite(dest, bytes) {
  const temporary = dest + '.clawdenote-tmp-' + randomUUID();
  await fs.writeFile(temporary, bytes);
  try { await fs.rename(temporary, dest); } catch (error) { await fs.rm(temporary, {force:true}); throw error; }
}
register('file:open', async kind => {
  const chosen = await dialog.showOpenDialog(win, {title:kind === 'image'?'Insert image':'Open notebook or PDF',properties:['openFile'],filters:FILTERS[kind] || FILTERS.document});
  if(chosen.canceled) return null;
  const filePath = chosen.filePaths[0];
  const stat = await fs.stat(filePath);
  if(stat.size > 300 * 1024 * 1024) throw new Error('This file exceeds the 300 MB limit. Try a smaller PDF.');
  const data = await fs.readFile(filePath);
  if(['.clawdenote','.inkstone'].includes(path.extname(filePath).toLowerCase())) notebookPaths.add(filePath);
  return {name:path.basename(filePath),path:filePath,data:new Uint8Array(data)};
});
async function saveFile(data, options) {
  if(!options || typeof options.name !== 'string' || !['clawdenote','inkstone','pdf','png','jpg','svg'].includes(options.extension)) throw new Error('Invalid save format');
  const buffer = typeof data === 'string' ? Buffer.from(data,'utf8') : Buffer.from(data);
  const isNotebook = options.extension === 'clawdenote' || options.extension === 'inkstone';
  let dest = isNotebook && !options.saveAs && notebookPaths.has(options.currentPath) ? options.currentPath : null;
  if(!dest) {
    const picked = await dialog.showSaveDialog(win, {title: isNotebook?'Save notebook':'Export '+options.extension.toUpperCase(),defaultPath:path.join(app.getPath('documents'),path.basename(options.name)),filters:[{name:options.extension.toUpperCase()+' file',extensions:[options.extension]}]});
    if(picked.canceled || !picked.filePath) return null;
    dest = picked.filePath;
    if(!path.extname(dest)) dest += '.' + options.extension;
  }
  await atomicWrite(dest,buffer);
  if(isNotebook) notebookPaths.add(dest);
  return {path:dest,name:path.basename(dest)};
}
register('file:save', (data, options) => {
  const run = fileSaveQueue.then(() => saveFile(data, options));
  fileSaveQueue = run.catch(() => {});
  return run;
});
register('recovery:save', async data => {
  if(typeof data !== 'string') throw new Error('Invalid recovery data');
  const run = recoveryQueue.then(() => atomicWrite(recoveryPath(),data));
  recoveryQueue = run.catch(() => {});
  await run;
});
register('recovery:read', async () => {
  try { return await fs.readFile(recoveryPath(),'utf8'); } catch(error) { if(error.code === 'ENOENT') return null; throw error; }
});
register('app:version', () => app.getVersion());
register('document:print', () => new Promise(resolve => win.webContents.print({printBackground:true,pageSize:'A4',margins:{marginType:'none'}},(success,reason) => resolve({success,reason}))));
register('document:confirm-close', async () => {
  const answer = await dialog.showMessageBox(win,{type:'question',title:'Save your notebook?',message:'Your latest changes are not saved to a notebook file.',detail:'Recovery is kept on this laptop. Save a notebook file to choose its location.',buttons:['Save notebook','Close with recovery','Cancel'],defaultId:0,cancelId:2,noLink:true});
  return answer.response;
});
ipcMain.on('document:close-ready', event => {localSender(event); closing=true; win.close();});
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({width:1440,height:1000,minWidth:1000,minHeight:700,title:'Clawdenote',icon:path.join(__dirname,'../build/icon.png'),backgroundColor:'#f4f3ee',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate',(event,url) => { if(!url.startsWith('file://') && !url.startsWith('http://127.0.0.1:5173/')) event.preventDefault(); });
  win.on('close', event => { if(!closing){event.preventDefault();win.webContents.send('document:closing');} });
  win.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('window-all-closed',()=>app.quit());
