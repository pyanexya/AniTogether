import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {request,authorizationUrl,validGrant,errorMessage,ApiError,avatars} from '../public/api.mjs';

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
 function element(id){if(!elements.has(id))elements.set(id,{id,hidden:false,disabled:false,checked:false,value:'',textContent:'',classList:{toggle(){}},handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}});return elements.get(id);}
 const controls=['username','displayName','bio','avatar'].map(element);controls.namedItem=name=>element(name);element('profile-form').elements=controls;
 const calls=[],stored=new Map();const profile={id:'test-user',username:'tester',displayName:'Тест',bio:'',avatar:'cat'};
 const context={document:{getElementById:element},location:{pathname:desktop?'/desktop':'/profile',hash:desktop?'#grant='+'x'.repeat(43):'',assign(url){calls.push({redirect:url});}},history:{replaceState(){}},sessionStorage:{getItem:key=>stored.get(key),setItem:(key,v)=>stored.set(key,v),removeItem:key=>stored.delete(key)},URLSearchParams,Date,confirm:()=>true,setTimeout:()=>1,clearTimeout(){},errorMessage,avatars,validGrant,authorizationUrl,FormData:class{constructor(form){return controls.filter(c=>!c.disabled).map(c=>[c.id,c.value]);}},request:async(path,options)=>{
  calls.push({path,options});
  if(path==='/api/capabilities')return {providers,profile:true,desktop:true};
  if(path==='/api/me'&&!options){if(!signedIn)throw new ApiError(401,'unauthenticated');return {profile,identities:['google'],csrfToken:'test-csrf',shikimori:null};}
  if(path==='/api/desktop/inspect')return {pairingCode:'ABC12345',expiresAt:Math.floor(Date.now()/1000)+120};
  return {ok:true};
 }};
 vm.runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,''),context);
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
 const save=h.calls.find(c=>c.path==='/api/me'&&c.options?.method==='PATCH');assert(save);assert.equal(save.options.data.displayName,'Новое имя');assert.deepEqual(Object.keys(save.options.data).sort(),['avatar','bio','displayName','username']);assert.equal(h.element('save-status').textContent,'Сохранено');
});
