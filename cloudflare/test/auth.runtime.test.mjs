import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {hash,random} from '../src/security.mjs';
const origin='https://aniartix.pyanexy.cc';
test('workerd D1: real router migration, bearer profile authorization and PKCE one-use',async()=>{
 const bundle=await build({entryPoints:[new URL('../src/index.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-01',bindings:{APP_ORIGIN:origin},d1Databases:['DB'],durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
 try {
  const db=await mf.getD1Database('DB');const migration=await readFile(new URL('../migrations/0001_auth.sql',import.meta.url),'utf8');for(const sql of migration.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  const token=random(),csrf=random(),user='runtime-user',t=Math.floor(Date.now()/1000);
  await db.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').bind(user,'runtime_user','Runtime',t).run();
  await db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) VALUES(?,?,?,?,?)').bind(await hash(token),user,csrf,t+600,t).run();
  const call=(path,method='GET',data,headers={})=>mf.dispatchFetch(origin+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});
  const headers={Authorization:'Bearer '+token};assert.equal((await call('/api/me')).status,401);assert.equal((await call('/api/me','PATCH',{bio:'D1 checked'},headers)).status,200);assert.equal((await (await call('/api/me','GET',null,headers)).json()).profile.bio,'D1 checked');
  const verifier=random(),g=await (await call('/api/desktop/start','POST',{challenge:await hash(verifier)})).json();
  const cookie={Cookie:'__Host-anixartix='+token,Origin:origin,'X-CSRF-Token':csrf};const inspect=await (await call('/api/desktop/inspect','POST',{grant:g.grant},cookie)).json();assert.equal(inspect.pairingCode,g.pairingCode);
  assert.equal((await call('/api/desktop/approve','POST',{grant:g.grant,consent:true},cookie)).status,200);
  const [one,two]=await Promise.all([call('/api/desktop/exchange','POST',{grant:g.grant,verifier}),call('/api/desktop/exchange','POST',{grant:g.grant,verifier})]);assert.deepEqual([one.status,two.status].sort(),[200,400]);

  // An approved pending grant must not resurrect a session after revoke-all.
  const prepareGrant=async()=>{const verifier=random();const grant=await (await call('/api/desktop/start','POST',{challenge:await hash(verifier)})).json();assert.equal((await call('/api/desktop/approve','POST',{grant:grant.grant,consent:true},cookie)).status,200);return {grant:grant.grant,verifier};};
  const pending=await prepareGrant();
  assert.equal((await call('/api/auth/sessions','DELETE',null,headers)).status,200);
  assert.equal((await call('/api/desktop/exchange','POST',pending)).status,400);
  // Race exchange against revoke: exchange may fail or succeed, but no issued token survives.
  for(let i=0;i<3;i++){
   await db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) VALUES(?,?,?,?,?)').bind(await hash(token),user,csrf,t+600,t).run();
   const pending=await prepareGrant();const [ex,revoke]=await Promise.all([call('/api/desktop/exchange','POST',pending),call('/api/auth/sessions','DELETE',null,headers)]);
   assert.equal(revoke.status,200);assert.ok([200,400].includes(ex.status));if(ex.status===200){const issued=await ex.json();assert.equal((await call('/api/me','GET',null,{Authorization:'Bearer '+issued.accessToken})).status,401);}
   assert.equal((await db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id=?').bind(user).first()).count,0);
  }
 }finally{await mf.dispose();}
});
