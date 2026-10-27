export const avatars = {'':'◉',cat:'🐈',moon:'☾',star:'★',sakura:'🌸',fox:'🦊'};
export class ApiError extends Error {
 constructor(status,code){super(code);this.status=status;this.code=code;}
}
export async function request(path,{method='GET',data,csrfToken,fetcher=fetch}={}){
 const headers={Accept:'application/json'};
 if(data!==undefined)headers['Content-Type']='application/json';
 if(csrfToken)headers['X-CSRF-Token']=csrfToken;
 let res;
 try{res=await fetcher(path,{method,headers,credentials:'same-origin',cache:'no-store',body:data===undefined?undefined:JSON.stringify(data)});}catch{throw new ApiError(0,'network_error');}
 let value;try{value=await res.json();}catch{throw new ApiError(res.status,'invalid_response');}
 if(!res.ok)throw new ApiError(res.status,typeof value?.error==='string'?value.error:'request_failed');
 return value;
}
export function authorizationUrl(provider,value){
 const allowed={google:'accounts.google.com',discord:'discord.com',shikimori:'shikimori.io'};
 const url=new URL(value);
 if(!allowed[provider]||url.protocol!=='https:'||url.hostname!==allowed[provider]||url.port||url.username||url.password)throw new ApiError(0,'invalid_authorization_url');
 return url.href;
}
export function validGrant(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);}
export function errorMessage(error){
 const codes={network_error:'Не удалось связаться с сервером. Проверь соединение и повтори попытку.',provider_not_configured:'Вход через этого провайдера ещё не настроен.',database_not_configured:'Хранилище аккаунтов пока не настроено.',identity_or_username_already_in_use:'Это имя пользователя уже занято. Выбери другое.',invalid_username:'Ник: 3–24 латинские буквы, цифры или _.',invalid_display_name:'Имя должно содержать от 1 до 64 символов.',invalid_bio:'Описание не должно превышать 500 символов.',invalid_profile:'Проверь поля: переносы строк и управляющие символы не поддерживаются.',invalid_grant:'Запрос входа истёк или уже использован. Начни вход заново в приложении.',rate_limited:'Слишком много запросов. Немного подожди и попробуй ещё раз.',invalid_authorization_url:'Сервер вернул недопустимый адрес входа.',explicit_consent_required:'Подтверди своё согласие перед продолжением.'};
 if(error.status===401)return 'Сессия завершилась. Войди снова.';
 if(error.status===403)return 'Не удалось подтвердить запрос. Обнови страницу и повтори действие.';
 return codes[error.code]||'Не удалось выполнить действие. Попробуй ещё раз.';
}
