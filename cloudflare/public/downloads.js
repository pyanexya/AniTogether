import {validRelease} from './release.mjs';
const $=id=>document.getElementById(id);
try {
 const response=await fetch('/downloads/release.json',{cache:'no-store',credentials:'omit'});
 if(!response.ok)throw Error('unavailable');
 const data=await response.json(),r=data.release;
 if(data.schemaVersion!==1||!validRelease(r))throw Error('unavailable');
 $('release-version').textContent=r.version;
 $('release-date').textContent=new Date(r.date).toLocaleDateString('ru-RU',{timeZone:'UTC',year:'numeric',month:'long',day:'numeric'});
 $('release-size').textContent=`${(r.installer.size/1048576).toLocaleString('ru-RU',{maximumFractionDigits:2})} МиБ`;
 $('installer-hash').textContent=r.installer.sha256;$('source-hash').textContent=r.source.sha256;$('release-commit').textContent=r.commit;
 $('download-button').href=r.installer.url;$('source-link').href=r.source.url;
 for(const id of ['download-button','source-link','release-details','integrity'])$(id).hidden=false;
 $('download-unavailable').hidden=true;$('source-pending').hidden=true;
 $('download-status').textContent='Готово к скачиванию · без входа в аккаунт';
}catch {
 $('download-status').textContent='Установщик ещё не опубликован. Ссылка появится здесь после проверки сборки.';
}
