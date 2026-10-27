import {request,authorizationUrl,validGrant,errorMessage,avatars} from './api.mjs';
import {initAvatarEditor,safeAvatarUrl} from './avatar.mjs';
const $=id=>document.getElementById(id);
const storageKey='anixartix.pendingDesktopGrant';
let capabilities=null,me=null,busy=false,grant=null,pairing=null,expiryTimer;
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function storeGrant(value){try{if(value)sessionStorage.setItem(storageKey,value);else sessionStorage.removeItem(storageKey);}catch{/* In-memory pairing still works; OAuth cannot retain it. */}}
function captureGrant(){
 const fragment=new URLSearchParams(location.hash.slice(1));
 const incoming=fragment.get('grant');
 if(location.pathname==='/desktop'&&incoming!==null){
  history.replaceState(null,'',location.pathname);
  storeGrant(null);
  if(validGrant(incoming)){grant=incoming;storeGrant(grant);}else notice('Некорректная ссылка входа. Начни вход заново в приложении.',true);
 }else{try{const saved=sessionStorage.getItem(storageKey);if(validGrant(saved))grant=saved;else storeGrant(null);}catch{}}
}
function updateButtons(){
 for(const provider of ['google','discord'])$(provider).disabled=busy||!capabilities?.providers?.[provider];
 $('link').disabled=busy||!capabilities?.providers?.shikimori||!$('link-consent').checked;
 $('approve').disabled=busy||!pairing||pairing.expiresAt*1000<=Date.now()||!$('pairing-consent').checked;
 for(const id of ['unlink','logout','revoke','cancel-pairing'])$(id).disabled=busy;
 for(const control of $('profile-form').elements)control.disabled=busy;
 $('upload-avatar').disabled=busy;
 for(const button of $('avatar-choices').querySelectorAll('button'))button.disabled=busy;
}
async function perform(action){if(busy)return;busy=true;updateButtons();try{await action();}catch(error){notice(errorMessage(error),true);if(error.status===401){me=null;renderAccount();}if(error.code==='invalid_grant')clearPairing();}finally{busy=false;updateButtons();}}
function renderCapabilities(){
 const labels={google:'Google',discord:'Discord',shikimori:'Shikimori'};
 const missing=Object.keys(labels).filter(key=>!capabilities.providers?.[key]);
 $('provider-state').textContent=['google','discord'].every(key=>!capabilities.providers?.[key])?'Вход пока недоступен: владелец ещё не подключил провайдеров.':'Выбери доступный способ входа. Неактивные провайдеры ещё не подключены.';
 $('setup').hidden=missing.length===0&&!!capabilities.profile;
 $('setup-message').textContent=`Не настроены: ${missing.map(key=>labels[key]).join(', ')||'нет'}${capabilities.profile?'':'. Хранилище профилей недоступно'}.`;
 updateButtons();
}
function renderAccount(){
 $('login').hidden=!!me;$('account').hidden=!me;
 document.title=me?'AnixArtix · мой профиль':'AnixArtix · вход';
 if(!me){$('pairing').hidden=true;avatarEditor.reset();return;}
 const profile=me.profile;
 for(const key of ['displayName','username','bio'])$('profile-form').elements.namedItem(key).value=profile[key]||'';
 $('profile-title').textContent=profile.displayName||'Твой профиль';
 $('profile-handle').textContent=profile.username?'@'+profile.username:'';
 const avatarUrl=safeAvatarUrl(profile.avatarUrl);
 $('avatar-image').hidden=!avatarUrl;$('avatar-symbol').hidden=!!avatarUrl;
 if(avatarUrl)$('avatar-image').src=avatarUrl;else $('avatar-image').removeAttribute('src');
 $('avatar-symbol').textContent=avatars[profile.avatar]||avatars[''];
 for(const button of $('avatar-choices').querySelectorAll('button'))button.setAttribute('aria-pressed',String(!avatarUrl&&button.dataset.avatar===(profile.avatar||'')));
 $('identities').textContent=`Вход в этот аккаунт: ${(me.identities||[]).map(value=>({google:'Google',discord:'Discord'}[value])).filter(Boolean).join(', ')||'провайдер не указан'}.`;
 $('shikimori-state').textContent=me.shikimori?`Привязан: ${me.shikimori.nickname||'пользователь Shikimori'}`:capabilities?.providers?.shikimori?'Аккаунт не привязан.':'Привязка пока недоступна: OAuth Shikimori не настроен.';
 $('unlink').hidden=!me.shikimori;$('shikimori-consent').hidden=!!me.shikimori;
 $('link-consent').checked=false;updateButtons();
}
function clearPairing(){grant=null;pairing=null;storeGrant(null);clearTimeout(expiryTimer);$('pairing').hidden=true;$('pairing-consent').checked=false;}
async function inspectPairing(){
 if(!grant||!me)return;
 pairing=await request('/api/desktop/inspect',{method:'POST',data:{grant},csrfToken:me.csrfToken});
 $('pairing').hidden=false;$('pairing-code').textContent=pairing.pairingCode;
 $('pairing-consent').checked=false;$('pairing-status').textContent='';
 $('pairing-expiry').textContent=`Запрос действует до ${new Date(pairing.expiresAt*1000).toLocaleTimeString('ru-RU')}.`;
 clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{pairing=null;$('pairing-status').textContent='Время подтверждения истекло. Начни вход заново в приложении.';storeGrant(null);updateButtons();},Math.max(0,pairing.expiresAt*1000-Date.now()));
 updateButtons();
}
async function refreshMe(){me=await request('/api/me');renderAccount();}
async function load(){
 $('retry').hidden=true;notice('Проверяем доступность входа…');
 try{
  capabilities=await request('/api/capabilities');renderCapabilities();
  try{await refreshMe();}catch(error){if(error.status!==401)throw error;me=null;renderAccount();}
  notice(me?'':grant?'Для подтверждения входа в приложение сначала войди в свой аккаунт.':'Вход безопасно перенаправит тебя на сайт выбранного провайдера.');
  await inspectPairing();
 }catch(error){notice(errorMessage(error),true);$('retry').hidden=false;if(error.code==='invalid_grant')clearPairing();}
 updateButtons();
}
for(const provider of ['google','discord'])$(provider).addEventListener('click',()=>perform(async()=>{
 const data=await request(`/api/auth/${provider}/start`,{method:'POST'});
 location.assign(authorizationUrl(provider,data.authorizationUrl));
}));
$('profile-form').addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));perform(async()=>{
 $('save-status').textContent='Сохраняем…';
 try{await request('/api/me',{method:'PATCH',data,csrfToken:me.csrfToken});await refreshMe();$('save-status').textContent='Сохранено';notice('Профиль обновлён.');}catch(error){$('save-status').textContent='Не сохранено';throw error;}
});});
$('link-consent').addEventListener('change',updateButtons);
$('link').addEventListener('click',()=>perform(async()=>{
 if(!$('link-consent').checked)return;
 const data=await request('/api/auth/shikimori/start',{method:'POST',data:{consent:true},csrfToken:me.csrfToken});location.assign(authorizationUrl('shikimori',data.authorizationUrl));
}));
$('unlink').addEventListener('click',()=>perform(async()=>{
 if(!confirm('Отвязать Shikimori от AnixArtix? Для полного отзыва доступа потребуется также открыть настройки Shikimori.'))return;
 await request('/api/shikimori',{method:'DELETE',csrfToken:me.csrfToken});await refreshMe();$('link-status').textContent='Связь удалена в AnixArtix. Для полного отзыва доступа удали разрешение AnixArtix в настройках своего аккаунта Shikimori.';notice('Shikimori отвязан.');
}));
for(const [id,path,method] of [['logout','/api/auth/logout','POST'],['revoke','/api/auth/sessions','DELETE']])$(id).addEventListener('click',()=>perform(async()=>{
 if(id==='revoke'&&!confirm('Завершить все сессии AnixArtix, включая приложение и этот браузер?'))return;
 await request(path,{method,csrfToken:me.csrfToken});me=null;clearPairing();renderAccount();notice(id==='revoke'?'Все сессии завершены.':'Ты вышел из аккаунта.');
}));
$('pairing-consent').addEventListener('change',updateButtons);
$('approve').addEventListener('click',()=>perform(async()=>{
 if(!$('pairing-consent').checked||!pairing||pairing.expiresAt*1000<=Date.now())return;
 await request('/api/desktop/approve',{method:'POST',data:{grant,consent:true},csrfToken:me.csrfToken});clearPairing();notice('Вход подтверждён. Вернись в приложение AnixArtix.');
}));
$('cancel-pairing').addEventListener('click',()=>{clearPairing();notice('Вход не подтверждён. Запрос в приложении истечёт автоматически.');});
$('retry').addEventListener('click',()=>perform(load));
const avatarEditor=initAvatarEditor({getMe:()=>me,isBusy:()=>busy,perform,onSaved:refreshMe});
$('avatar-image').addEventListener('error',()=>{$('avatar-image').hidden=true;$('avatar-symbol').hidden=false;});
captureGrant();perform(load);
