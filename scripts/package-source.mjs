import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
// A deterministic source archive, independent of additional ZIP tools.
const names=[];
function collect(name){if(statSync(name).isDirectory()){for(const entry of readdirSync(name).sort())collect(path.join(name,entry));}else names.push(name.replaceAll('\\','/'));}
for(const name of ['src','electron','scripts','tests','build','.github','docs','index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts','vitest.config.ts','playwright.config.ts','README.md','LICENSE','THIRD_PARTY_NOTICES.txt','.gitignore'])collect(name);
function crc(data){let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
const local=[],central=[];let offset=0;
for(const name of names){const file=readFileSync(name),data=deflateRawSync(file),filename=Buffer.from(name);const checksum=crc(file);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(33,12);h.writeUInt32LE(checksum,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(file.length,22);h.writeUInt16LE(filename.length,26);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(33,14);c.writeUInt32LE(checksum,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(file.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);local.push(h,filename,data);central.push(c,filename);offset+=h.length+filename.length+data.length;}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(names.length,8);end.writeUInt16LE(names.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);writeFileSync('Clawdenote-Source.zip',Buffer.concat([...local,directory,end]));
console.log(`Source archive: ${names.length} files`);
