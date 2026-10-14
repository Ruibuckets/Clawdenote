import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
const size=256, pixels=Buffer.alloc((size*4+1)*size);
const polygons=[[[66,181],[80,144],[106,170]],[[85,137],[160,62],[186,88],[111,163]],[[165,57],[176,46],[185,44],[204,63],[202,72],[191,83]]];
function inside(x,y,poly){let c=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])c=!c;}return c;}
for(let y=0;y<size;y++){for(let x=0;x<size;x++){const o=y*(size*4+1)+1+x*4;const corner=(x<45&&y<45&&Math.hypot(x-45,y-45)>45)||(x>210&&y<45&&Math.hypot(x-210,y-45)>45)||(x>210&&y>210&&Math.hypot(x-210,y-210)>45)||(x<45&&y>210&&Math.hypot(x-45,y-210)>45);const nib=polygons.some(p=>inside(x,y,p));const underline=y>204&&y<209&&x>62&&x<193;const color=nib?[246,247,233]:underline?[184,204,156]:[49,92,72];pixels[o]=color[0];pixels[o+1]=color[1];pixels[o+2]=color[2];pixels[o+3]=corner?0:255}}
function crc(data){let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function chunk(kind,data){const t=Buffer.from(kind),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length,0);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,data])),8+data.length);return b}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
mkdirSync('build',{recursive:true});writeFileSync('build/icon.png',png);writeFileSync('build/icon.ico',Buffer.concat([header,png]));
