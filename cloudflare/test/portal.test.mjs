import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {request,authorizationUrl,validGrant,errorMessage,ApiError,avatars} from '../public/api.mjs';
import {cropRectangle,validateAvatarFile,safeAvatarUrl,MAX_INPUT_BYTES} from '../public/avatar.mjs';

test('portal sends browser session cookies and CSRF for protected JSON mutations',async()=>{
 let called;
 const result=await request('/api/me',{method:'PATCH',data:{displayName:'Маша'},csrfToken:'test-csrf',fetcher:async(path,options)=>{called={path,options};return Response.json({ok:true});}});
 assert.equal(result.ok,true);assert.equal(called.path,'/api/me');assert.equal(called.options.credentials,'same-origin');assert.equal(called.options.cache,'no-store');assert.equal(called.options.headers['X-CSRF-Token'],'test-csrf');assert.deepEqual(JSON.parse(called.options.body),{displayName:'Маша'});
});
test('portal converts missing credentials, expiry, network and invalid JSON to safe errors',async()=>{
 for(const [status,code] of [[401,'unauthenticated'],[503,'provider_not_configured'],[400,'invalid_grant']]){
  await assert.rejects(request('/api/me',{fetcher:async()=>Response.json({error:code},{status})}),e=>e instanceof ApiError&&e.status===status&&e.code===code);
 }
 await assert.rejects(request('/api/me',{fetcher:async()=>{throw Error('sensitive backend details');}}),e=>e.code==='network_error'&&!e.message.includes('sensitive'));
 await assert.rejects(request('/api/me',{fetcher:async()=>new Response('<html>')}),e=>e.code==='invalid_response');
 assert(!errorMessage(new ApiError(500,'secret-from-server')).includes('secret'));
});
test('OAuth redirects allow exact HTTPS provider host only',()=>{
 for(const [provider,host] of [['google','accounts.google.com'],['discord','discord.com'],['shikimori','shikimori.io']])assert.equal(authorizationUrl(provider,`https://${host}/oauth?state=x`),`https://${host}/oauth?state=x`);
 for(const url of ['javascript:alert(1)','https://evil.test','http://discord.com','https://discord.com.evil.test','https://u:p@discord.com','https://discord.com:8443'])assert.throws(()=>authorizationUrl('discord',url));
 assert.throws(()=>authorizationUrl('unknown','https://discord.com'));
});
test('desktop grant validation accepts only expected opaque token shape',()=>{
 assert(validGrant('x'.repeat(43)));for(const value of [null,undefined,'x'.repeat(42),'x'.repeat(44),'<'.repeat(43),'x'.repeat(42)+' '])assert(!validGrant(value));
});
test('portal has no inline executable/style content, untrusted HTML sink, or persisted bearer tokens',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));assert(!/\s(?:onclick|onload|onerror|style)=/i.test(html));assert(!/<style/i.test(html));
 assert(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|accessToken/.test(js));
 assert(html.includes('lang="ru"'));assert(html.includes('type="checkbox"'));assert(js.includes("if(!$('pairing-consent').checked||!pairing"));
 assert.equal(Object.keys(avatars).length,6);
});
test('profile snapshot is captured before busy state disables form fields',()=>{
 const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(js,/event\.preventDefault\(\);const data=Object\.fromEntries\(new FormData\(event\.target\)\);perform\(async/);
});

import vm from 'node:vm';
function portalHarness({signedIn=false,desktop=false,providers={google:false,discord:false,shikimori:false}}={}){
 const elements=new Map();
 function element(id){if(!elements.has(id))elements.set(id,{id,hidden:false,disabled:false,checked:false,value:'',textContent:'',classList:{toggle(){}},querySelectorAll(){return [];},removeAttribute(){},setAttribute(){},handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}});return elements.get(id);}
 const controls=['username','displayName','bio'].map(element);controls.namedItem=name=>element(name);element('profile-form').elements=controls;
 const calls=[],stored=new Map();const profile={id:'test-user',username:'tester',displayName:'Тест',bio:'',avatar:'cat'};
 const context={document:{getElementById:element},location:{pathname:desktop?'/desktop':'/profile',hash:desktop?'#grant='+'x'.repeat(43):'',assign(url){calls.push({redirect:url});}},history:{replaceState(){}},sessionStorage:{getItem:key=>stored.get(key),setItem:(key,v)=>stored.set(key,v),removeItem:key=>stored.delete(key)},URLSearchParams,Date,confirm:()=>true,setTimeout:()=>1,clearTimeout(){},errorMessage,avatars,validGrant,authorizationUrl,safeAvatarUrl,initAvatarEditor:()=>({reset(){}}),FormData:class{constructor(form){return controls.filter(c=>!c.disabled).map(c=>[c.id,c.value]);}},request:async(path,options)=>{
  calls.push({path,options});
  if(path==='/api/capabilities')return {providers,profile:true,desktop:true};
  if(path==='/api/me'&&!options){if(!signedIn)throw new ApiError(401,'unauthenticated');return {profile,identities:['google'],csrfToken:'test-csrf',shikimori:null};}
  if(path==='/api/desktop/inspect')return {pairingCode:'ABC12345',expiresAt:Math.floor(Date.now()/1000)+120};
  return {ok:true};
 }};
 vm.runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,''),context);
 return {element,calls,stored,async settle(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}};
}
test('DOM boot keeps unavailable login providers disabled without fabricated session',async()=>{
 const h=portalHarness();await h.settle();assert(h.element('google').disabled);assert(h.element('discord').disabled);assert.equal(h.element('login').hidden,false);assert.equal(h.element('account').hidden,true);assert(!h.calls.some(c=>c.path.includes('/start')));
});
test('DOM desktop flow inspects but never approves until matching-code checkbox and button',async()=>{
 const h=portalHarness({signedIn:true,desktop:true});await h.settle();assert.equal(h.element('pairing-code').textContent,'ABC12345');assert(h.element('approve').disabled);assert(!h.calls.some(c=>c.path==='/api/desktop/approve'));
 await h.element('approve').handlers.click();assert(!h.calls.some(c=>c.path==='/api/desktop/approve'));
 h.element('pairing-consent').checked=true;h.element('pairing-consent').handlers.change();assert(!h.element('approve').disabled);
 await h.element('approve').handlers.click();const approved=h.calls.find(c=>c.path==='/api/desktop/approve');assert.equal(approved.options.data.consent,true);assert.equal(approved.options.csrfToken,'test-csrf');assert.equal(h.stored.size,0);assert(h.element('pairing').hidden);
});
test('DOM profile submit sends populated allowlisted form fields despite busy disabling',async()=>{
 const h=portalHarness({signedIn:true});await h.settle();h.element('displayName').value='Новое имя';h.element('profile-form').handlers.submit({preventDefault(){},target:h.element('profile-form')});await h.settle();
 const save=h.calls.find(c=>c.path==='/api/me'&&c.options?.method==='PATCH');assert(save);assert.equal(save.options.data.displayName,'Новое имя');assert.deepEqual(Object.keys(save.options.data).sort(),['bio','displayName','username']);assert.equal(h.element('save-status').textContent,'Сохранено');
});


test('avatar crop bounds cover portrait, landscape, zoom and edge positions',()=>{
 assert.deepEqual(cropRectangle(800,400),{x:200,y:0,side:400});
 assert.deepEqual(cropRectangle(400,800),{x:0,y:200,side:400});
 assert.deepEqual(cropRectangle(600,600,3,1,0),{x:400,y:0,side:200});
 assert.deepEqual(cropRectangle(600,600,99,99,-3),{x:400,y:0,side:200});
});
test('avatar files reject unsupported, empty and oversized input',()=>{
 for(const type of ['image/jpeg','image/png','image/webp'])assert.doesNotThrow(()=>validateAvatarFile({type,size:1024}));
 for(const file of [null,{type:'image/svg+xml',size:100},{type:'image/png',size:0},{type:'image/png',size:MAX_INPUT_BYTES+1}])assert.throws(()=>validateAvatarFile(file));
});
test('avatar URLs accept only versioned same-origin endpoint',()=>{
 assert.equal(safeAvatarUrl('/api/avatars/user_123?v=abcd'),'/api/avatars/user_123?v=abcd');
 for(const value of ['https://evil.test/avatar.png','//evil.test/a','data:image/png;base64,AA','/api/avatars/../me?v=a',null])assert.equal(safeAvatarUrl(value),null);
});
test('PNG upload is binary with cookies and CSRF, not JSON or multipart',async()=>{
 const blob=new Blob(['test'],{type:'image/png'});let captured;
 await request('/api/me/avatar',{method:'PUT',blob,csrfToken:'csrf',fetcher:async(path,options)=>{captured={path,options};return Response.json({profile:{}});}});
 assert.equal(captured.path,'/api/me/avatar');assert.equal(captured.options.method,'PUT');assert.equal(captured.options.body,blob);assert.equal(captured.options.headers['Content-Type'],'image/png');assert.equal(captured.options.headers['X-CSRF-Token'],'csrf');assert.equal(captured.options.credentials,'same-origin');
});

function cropHarness({decodeError=false,largeOutput=false,uploadError=false}={}){
 const nodes=new Map(),requests=[],revoked=[];let saved=0,busy=false,pending;
 function node(id){if(!nodes.has(id))nodes.set(id,{value:'',open:false,disabled:false,textContent:'',handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},querySelectorAll(){return [];},focus(){},click(){this.handlers.click?.();},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},getContext(){return {clearRect(){},drawImage(){}};},toBlob(fn){fn(new Blob([new Uint8Array(largeOutput?100000:1000)],{type:'image/png'}));},setPointerCapture(){},getBoundingClientRect(){return {width:300};}});return nodes.get(id);}
 const context={document:{getElementById:node,createElement:()=>node('output')},URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:v=>revoked.push(v)},Image:class{naturalWidth=800;naturalHeight=600;async decode(){if(decodeError)throw new Error('broken');}},Error,Math,Promise,Blob,errorMessage,request:async(path,options)=>{requests.push({path,options});if(uploadError)throw new ApiError(500,'failed');if(pending)await pending;}};
 const source=readFileSync(new URL('../public/avatar.mjs',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/export /g,'');
 vm.runInNewContext(source+'\nglobalThis.init=initAvatarEditor;',context);
 const editor=context.init({getMe:()=>({csrfToken:'csrf'}),isBusy:()=>busy,perform:async fn=>{if(busy)return;busy=true;try{await fn();}finally{busy=false;}},onSaved:async()=>{saved++;}});
 return {node,requests,revoked,editor,get saved(){return saved;},hold(){let resolve;pending=new Promise(r=>resolve=r);return resolve;},async open(file={type:'image/png',size:100}){node('avatar-file').files=[file];await node('avatar-file').handlers.change();}};
}
test('crop cancellation releases blob and repeated selection starts fresh without upload',async()=>{
 const h=cropHarness();await h.open();assert(h.node('crop-dialog').open);h.node('crop-zoom').value='3';h.node('crop-cancel').handlers.click();assert(!h.node('crop-dialog').open);assert.equal(h.requests.length,0);assert.equal(h.revoked.length,1);
 await h.open();assert(h.node('crop-dialog').open);assert.equal(h.node('crop-zoom').value,'1');let prevented=false;h.node('crop-dialog').handlers.cancel({preventDefault(){prevented=true;}});assert(prevented);assert(!h.node('crop-dialog').open);assert.equal(h.requests.length,0);
});
test('crop invalid or undecodable file never opens modal or uploads',async()=>{
 const h=cropHarness();await h.open({type:'image/svg+xml',size:100});assert(!h.node('crop-dialog').open);assert.equal(h.requests.length,0);assert(h.node('avatar-status').textContent);
 const broken=cropHarness({decodeError:true});await broken.open();assert(!broken.node('crop-dialog').open);assert.equal(broken.requests.length,0);assert.equal(broken.revoked.length,1);
});
test('crop repeated save is single-flight and Escape cannot dismiss in-flight upload',async()=>{
 const h=cropHarness();await h.open();const release=h.hold();const first=h.node('crop-save').handlers.click();await new Promise(r=>setImmediate(r));assert.equal(h.requests.length,1);await h.node('crop-save').handlers.click();h.node('crop-dialog').handlers.cancel({preventDefault(){}});assert(h.node('crop-dialog').open);assert.equal(h.requests.length,1);release();await first;assert.equal(h.saved,1);assert(!h.node('crop-dialog').open);assert.equal(h.requests[0].options.csrfToken,'csrf');
});
test('crop upload failure and oversized output keep editor recoverable',async()=>{
 for(const options of [{uploadError:true},{largeOutput:true}]){const h=cropHarness(options);await h.open();await h.node('crop-save').handlers.click();assert(h.node('crop-dialog').open);assert(!h.node('crop-save').disabled);assert(h.node('crop-status').textContent);assert.equal(h.saved,0);if(options.largeOutput)assert.equal(h.requests.length,0);h.node('crop-cancel').handlers.click();assert(!h.node('crop-dialog').open);}
});
