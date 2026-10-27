import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {build} from 'esbuild';
import {Miniflare,createFetchMock} from 'miniflare';
import {hash,random} from '../src/security.mjs';
import {discordAvatarUrl,validatePng} from '../src/avatars.mjs';
const origin='https://aniartix.pyanexy.cc';
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;}
function png({size=256,raw,extra=[],color=6,depth=8}={}){const head=Buffer.alloc(13);head.writeUInt32BE(size);head.writeUInt32BE(size,4);head[8]=depth;head[9]=color;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),...extra,chunk('IDAT',deflateSync(raw||Buffer.alloc((size*4+1)*size))),chunk('IEND',Buffer.alloc(0))]);}
const valid=png();
const bundle=await build({entryPoints:[new URL('../src/index.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
async function fixture(){
 const fetchMock=createFetchMock();fetchMock.disableNetConnect();const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-01',fetchMock,bindings:{APP_ORIGIN:origin,DISCORD_CLIENT_ID:'test',DISCORD_CLIENT_SECRET:'test'},d1Databases:['DB'],durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
 const db=await mf.getD1Database('DB');for(const sql of (await readFile(new URL('../migrations/0001_auth.sql',import.meta.url),'utf8')).split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 const token=random(),csrf=random(),t=Math.floor(Date.now()/1000);for(const id of ['alice','bob'])await db.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').bind(id,id,id,t).run();
 await db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) VALUES(?,?,?,?,?)').bind(await hash(token),'alice',csrf,t+600,t).run();
 const headers={Cookie:'__Host-anixartix='+token,Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'image/png'};
 const call=(path,options={})=>mf.dispatchFetch(origin+path,{redirect:'manual',...options});const upload=(body=valid,h=headers)=>call('/api/me/avatar',{method:'PUT',headers:h,body});
 return {mf,db,fetchMock,call,headers,upload};
}
test('workerd avatars: authentication, CSRF, own-row isolation, safe serving and builtin replacement',async()=>{const f=await fixture();try{
 assert.equal((await f.upload(valid,{'Content-Type':'image/png'})).status,401);
 assert.equal((await f.upload(valid,{...f.headers,'X-CSRF-Token':'bad'})).status,403);
 const response=await f.upload();assert.equal(response.status,200,await response.clone().text());const {profile}=await response.json();assert.equal(profile.avatar,'');assert.match(profile.avatarUrl,/^\/api\/avatars\/alice\?v=/);assert.ok(!JSON.stringify(profile).includes('png1:'));
 assert.equal((await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('bob').first()).avatar,'');
 const image=await f.call(profile.avatarUrl);assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/png');assert.equal(image.headers.get('Cache-Control'),'no-store');assert.equal(image.headers.get('X-Content-Type-Options'),'nosniff');assert.match(image.headers.get('Content-Security-Policy'),/sandbox/);assert.deepEqual(Buffer.from(await image.arrayBuffer()),valid);
 assert.equal((await f.call('/api/avatars/bob')).status,404);
 const r=await f.call('/api/me',{method:'PATCH',headers:{...f.headers,'Content-Type':'application/json'},body:JSON.stringify({avatar:'fox'})});assert.equal(r.status,200);assert.equal((await f.call('/api/avatars/alice')).status,404);
}finally{await f.mf.dispose();}});
test('workerd avatars: MIME spoof, SVG, oversized body, CRC, inflate bomb and bad scanline rejected',async()=>{const f=await fixture();try{
 const badCrc=Buffer.from(valid);badCrc[badCrc.length-1]^=1;
 const cases=[[valid,'image/svg+xml',415],[Buffer.from('<svg/>'),'image/png',400],[Buffer.alloc(98305),'image/png',413],[badCrc,'image/png',400],[png({size:1,raw:Buffer.alloc(1000000)}),'image/png',400],[png({size:1,raw:Buffer.from([9,0,0,0,0])}),'image/png',400]];
 for(const [body,mime,status] of cases){const r=await f.upload(body,{...f.headers,'Content-Type':mime});assert.equal(r.status,status,await r.clone().text());}
 assert.equal((await f.upload()).status,429);assert.equal((await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('alice').first()).avatar,'');
}finally{await f.mf.dispose();}});
test('PNG strict decode strips metadata and rejects trailing data, huge dimensions, invalid palette and animation',async()=>{
 assert.deepEqual(await validatePng(png({extra:[chunk('tEXt',Buffer.from('tracking'))]})),new Uint8Array(valid));
 for(const bytes of [Buffer.concat([valid,Buffer.from('html')]),png({size:257}),png({extra:[chunk('acTL',Buffer.alloc(8))]}),png({size:1,color:3,depth:1,raw:Buffer.from([0,0]),extra:[chunk('PLTE',Buffer.alloc(9))]})])await assert.rejects(validatePng(bytes));
 const indexed=png({size:1,color:3,depth:1,raw:Buffer.from([0,0]),extra:[chunk('PLTE',Buffer.from([255,0,0]))]});assert.ok((await validatePng(indexed)).length);
 await assert.rejects(validatePng(png({size:1,color:3,depth:1,raw:Buffer.from([0,128]),extra:[chunk('PLTE',Buffer.from([255,0,0]))]})));
 assert.equal(discordAvatarUrl({id:'123',avatar:null,discriminator:'1234'}),'https://cdn.discordapp.com/embed/avatars/4.png');assert.equal(discordAvatarUrl({id:'123',avatar:'https://evil.test'}),null);
});
test('workerd Discord avatar imports defaults, updates provider images, preserves uploads and survives bad CDN',async()=>{const f=await fixture();try{
 await f.db.prepare('INSERT INTO identities(provider,provider_id,user_id) VALUES(?,?,?)').bind('discord','123','alice').run();
 const login=async({avatar=null,cdn=valid,status=200}={})=>{
  const start=await f.call('/api/auth/discord/start',{method:'POST',headers:{Origin:origin}});const state=new URL((await start.json()).authorizationUrl).searchParams.get('state'),cookie=start.headers.get('Set-Cookie').split(';')[0];
  f.fetchMock.get('https://discord.com').intercept({path:'/api/oauth2/token',method:'POST'}).reply(200,{access_token:'secret'});f.fetchMock.get('https://discord.com').intercept({path:'/api/v10/users/@me'}).reply(200,{id:'123',username:'Alice',avatar,discriminator:'0'});
  if(cdn!==false)f.fetchMock.get('https://cdn.discordapp.com').intercept({path:avatar?`/avatars/123/${avatar}.png?size=128`:'/embed/avatars/0.png'}).reply(status,cdn,{headers:{'Content-Type':'image/png',Location:'https://evil.test/redirect'}});
  const r=await f.call('/api/auth/discord/callback?state='+state+'&code=x',{headers:{Cookie:cookie}});assert.equal(r.status,303,await r.clone().text());
 };
 await login();let stored=(await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('alice').first()).avatar;assert.match(stored,/^png1:discord:/);
 await login({avatar:'a'.repeat(32),status:302});assert.equal((await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('alice').first()).avatar,stored);
 await login({avatar:'b'.repeat(32),cdn:png({size:1})});assert.notEqual((await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('alice').first()).avatar,stored);
 assert.equal((await f.upload()).status,200);stored=(await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('alice').first()).avatar;
 await login({cdn:false});assert.equal((await f.db.prepare('SELECT avatar FROM users WHERE id=?').bind('alice').first()).avatar,stored);f.fetchMock.assertNoPendingInterceptors();
}finally{await f.mf.dispose();}});

test('workerd avatars: per-account quota cannot be reset by changing client IP',async()=>{const f=await fixture();try{
 for(let i=0;i<6;i++){const r=await f.upload(valid,{...f.headers,'CF-Connecting-IP':`192.0.2.${i+1}`});assert.equal(r.status,200,await r.clone().text());}
 assert.equal((await f.upload(valid,{...f.headers,'CF-Connecting-IP':'192.0.2.99'})).status,429);
}finally{await f.mf.dispose();}});
