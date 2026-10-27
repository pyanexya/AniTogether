import {fail,hash} from './security.mjs';

// Existing users.avatar TEXT holds a bounded, versioned PNG, never a user-supplied URL.
export const AVATAR_LIMIT=96*1024;
const signature=Uint8Array.of(137,80,78,71,13,10,26,10);
const concat=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
export async function boundedBytes(stream,limit=AVATAR_LIMIT) {
 const reader=stream?.getReader();if(!reader)fail(400,'avatar_required');const parts=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail(413,'avatar_too_large');}parts.push(value);}}finally{reader.releaseLock();}
 return concat(parts);
}
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const out=new Uint8Array(data.length+12),v=new DataView(out.buffer);v.setUint32(0,data.length);out.set(new TextEncoder().encode(type),4);out.set(data,8);v.setUint32(data.length+8,crc32(out.subarray(4,data.length+8)));return out;}
export async function validatePng(bytes) {
 const invalid=()=>fail(400,'invalid_avatar_png');
 if(bytes.length>AVATAR_LIMIT)fail(413,'avatar_too_large');
 if(bytes.length<45||signature.some((b,i)=>bytes[i]!==b))invalid();
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let pos=8,header=null,palette=null,transparency=null,ended=false,idatEnded=false;const compressed=[];
 while(pos<bytes.length){
  if(pos+12>bytes.length)invalid();const n=view.getUint32(pos);if(n>AVATAR_LIMIT||pos+n+12>bytes.length)invalid();
  const type=String.fromCharCode(...bytes.subarray(pos+4,pos+8)),data=bytes.subarray(pos+8,pos+8+n);
  if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes.subarray(pos+4,pos+8+n))!==view.getUint32(pos+8+n))invalid();
  if(!header&&type!=='IHDR')invalid();
  if(type==='IHDR'){
   if(header||n!==13)invalid();header=data;
   const w=view.getUint32(pos+8),h=view.getUint32(pos+12);
   // Canvas RGB/RGBA or Discord indexed PNG. No animation, 16-bit or interlace.
   if(w<1||w>256||h!==w||!((data[8]===8&&[2,6].includes(data[9]))||(data[9]===3&&[1,2,4,8].includes(data[8])))||data[10]||data[11]||data[12])invalid();
  }else if(type==='PLTE'){if(palette||compressed.length||!n||n%3||n>768||(header[9]===3&&n/3>2**header[8]))invalid();palette=data;
  }else if(type==='tRNS'){if(transparency||compressed.length||header[9]!==3||!palette||!n||n>palette.length/3)invalid();transparency=data;
  }else if(type==='IDAT'){if(idatEnded||!n||(header[9]===3&&!palette))invalid();compressed.push(data);
  }else if(type==='IEND'){if(n||!compressed.length||pos+12!==bytes.length)invalid();ended=true;
  }else{
   if(type[0]===type[0].toUpperCase()||['acTL','fcTL','fdAT'].includes(type))invalid();
   if(compressed.length)idatEnded=true; // IDAT chunks must be consecutive.
  }
  pos+=n+12;
 }
 if(!ended)invalid();
 const w=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(0),channels=header[9]===6?4:header[9]===2?3:1,bpp=Math.max(1,Math.ceil(channels*header[8]/8)),stride=Math.ceil(w*channels*header[8]/8)+1,expected=stride*w;
 try{
  const raw=await boundedBytes(new Blob([concat(compressed)]).stream().pipeThrough(new DecompressionStream('deflate')),expected);
  if(raw.length!==expected)invalid();
  // Decode every scanline, including palette indices. Output allocation is <=256*256*4.
  const pixels=new Uint8Array((stride-1)*w),rowSize=stride-1;
  for(let y=0;y<w;y++){
   const filter=raw[y*stride];if(filter>4)invalid();
   for(let x=0;x<rowSize;x++){
    const at=y*rowSize+x,a=x>=bpp?pixels[at-bpp]:0,b=y?pixels[at-rowSize]:0,c=y&&x>=bpp?pixels[at-rowSize-bpp]:0,p=a+b-c;
    const pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
    const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;
    pixels[at]=(raw[y*stride+1+x]+predictor)&255;
   }
   if(header[9]===3)for(let x=0;x<w;x++){const bit=x*header[8],index=(pixels[y*rowSize+(bit>>3)]>>(8-header[8]-(bit%8)))&((1<<header[8])-1);if(index>=palette.length/3)invalid();}
  }
 }catch{invalid();}
 // Discard ancillary metadata and all trailing material. Only inert, verified PNG chunks remain.
 return concat([signature,chunk('IHDR',header),...(palette?[chunk('PLTE',palette)]:[]),...(transparency?[chunk('tRNS',transparency)]:[]),chunk('IDAT',concat(compressed)),chunk('IEND',new Uint8Array())]);
}
export async function encodeAvatar(bytes,source='upload') {
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return `png1:${source}:${await hash(binary)}:${btoa(binary)}`;
}
export function storedAvatar(value){
 if(typeof value!=='string'||value.length>AVATAR_LIMIT*4/3+100)return null;
 const m=/^png1:(upload|discord):([A-Za-z0-9_-]{43}):([A-Za-z0-9+/]+={0,2})$/.exec(value);return m?{source:m[1],version:m[2],data:m[3]}:null;
}
export function avatarResponse(value){
 const avatar=storedAvatar(value);if(!avatar)fail(404,'avatar_not_found');
 return new Response(Uint8Array.from(atob(avatar.data),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer'}});
}
export function discordAvatarUrl(user){
 if(!/^\d{1,30}$/.test(String(user.id)))return null;
 // 128px RGBA fits the 96KiB quota even for detailed photographic avatars.
 if(typeof user.avatar==='string'&&/^(a_)?[a-f0-9]{32}$/.test(user.avatar))return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
 if(user.avatar!=null)return null;
 const index=/^[1-9]\d{0,3}$/.test(String(user.discriminator||''))?Number(user.discriminator)%5:Number((BigInt(user.id)>>22n)%6n);
 return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
export async function importDiscordAvatar(env,userId,user){
 const row=await env.DB.prepare('SELECT avatar FROM users WHERE id=?').bind(userId).first();
 if(!row|| (row.avatar!==''&&storedAvatar(row.avatar)?.source!=='discord'))return;
 const url=discordAvatarUrl(user);if(!url)return;
 try{
  // URL is constructed exclusively from authenticated provider fields. Never follow redirects.
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(5000)});
  if(!r.ok||r.headers.get('Content-Type')?.split(';')[0]!=='image/png')return;
  const png=await validatePng(await boundedBytes(r.body));
  // Compare-and-swap preserves a custom selection saved while this fetch was in flight.
  await env.DB.prepare('UPDATE users SET avatar=? WHERE id=? AND avatar=?').bind(await encodeAvatar(png,'discord'),userId,row.avatar).run();
 }catch{/* CDN failure must never prevent authentication; retry at the next Discord login. */}
}
