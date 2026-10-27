import {request,errorMessage} from './api.mjs';
export const MAX_INPUT_BYTES=10*1024*1024,MAX_OUTPUT_BYTES=96*1024;
export function validateAvatarFile(file){
 if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Выбери изображение JPG, PNG или WebP.');
 if(!file.size||file.size>MAX_INPUT_BYTES)throw new Error('Изображение должно быть не больше 10 МБ.');
}
export function cropRectangle(width,height,zoom=1,x=.5,y=.5){
 const side=Math.min(width,height)/Math.max(1,Math.min(3,zoom));
 return {x:Math.max(0,Math.min(1,x))*(width-side),y:Math.max(0,Math.min(1,y))*(height-side),side};
}
export function safeAvatarUrl(value){return typeof value==='string'&&/^\/api\/avatars\/[a-zA-Z0-9_-]+\?v=[a-zA-Z0-9_-]+$/.test(value)?value:null;}
export function initAvatarEditor({getMe,isBusy,perform,onSaved}){
 const $=id=>document.getElementById(id),dialog=$('crop-dialog'),canvas=$('crop-canvas');
 let photo=null,objectUrl=null,generation=0,drag=null,saving=false,opening=false;
 function release(){generation++;photo=null;drag=null;if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}$('avatar-file').value='';}
 function close(){if(saving)return;dialog.close();release();$('upload-avatar').focus();}
 function draw(){if(!photo)return;const ctx=canvas.getContext('2d');const r=cropRectangle(photo.naturalWidth,photo.naturalHeight,+$('crop-zoom').value,+$('crop-x').value,+$('crop-y').value);ctx.clearRect(0,0,512,512);ctx.drawImage(photo,r.x,r.y,r.side,r.side,0,0,512,512);}
 function controlsDisabled(value){saving=value;for(const id of ['crop-close','crop-cancel','crop-save','crop-zoom','crop-x','crop-y'])$(id).disabled=value;}
 $('upload-avatar').addEventListener('click',()=>{if(!isBusy()&&!opening&&!saving)$('avatar-file').click();});
 $('avatar-file').addEventListener('change',async()=>{
 const file=$('avatar-file').files?.[0];if(!file)return;if(isBusy()||saving)return;
 release();const token=generation;opening=true;$('upload-avatar').disabled=true;$('avatar-status').textContent='Открываем изображение…';
 try{
  validateAvatarFile(file);objectUrl=URL.createObjectURL(file);const img=new Image();img.src=objectUrl;await img.decode();
  if(token!==generation)return;
  if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>40_000_000)throw new Error('Слишком большое разрешение. Выбери изображение до 40 мегапикселей.');
  photo=img;$('crop-zoom').value='1';$('crop-x').value=$('crop-y').value='0.5';$('crop-status').textContent='';$('avatar-status').textContent='';controlsDisabled(false);draw();dialog.showModal();$('crop-zoom').focus();
 }catch(error){if(token===generation){$('avatar-status').textContent=error instanceof Error&&error.name!=='EncodingError'?error.message:'Не удалось открыть изображение. Попробуй другой файл.';release();}}
 finally{opening=false;$('upload-avatar').disabled=isBusy();}
 });
 for(const id of ['crop-zoom','crop-x','crop-y'])$(id).addEventListener('input',draw);
 for(const id of ['crop-close','crop-cancel'])$(id).addEventListener('click',close);
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 dialog.addEventListener('close',()=>{if(!saving)release();});
 canvas.addEventListener('pointerdown',event=>{if(!photo||saving)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY,px:+$('crop-x').value,py:+$('crop-y').value};canvas.setPointerCapture(event.pointerId);});
 canvas.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId||saving)return;const r=cropRectangle(photo.naturalWidth,photo.naturalHeight,+$('crop-zoom').value);const scale=r.side/canvas.getBoundingClientRect().width;const dx=photo.naturalWidth-r.side,dy=photo.naturalHeight-r.side;$('crop-x').value=dx?Math.max(0,Math.min(1,drag.px-(event.clientX-drag.x)*scale/dx)):.5;$('crop-y').value=dy?Math.max(0,Math.min(1,drag.py-(event.clientY-drag.y)*scale/dy)):.5;draw();});
 for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>{drag=null;});
 $('crop-save').addEventListener('click',async()=>{
 if(!photo||saving||isBusy()||!getMe())return;controlsDisabled(true);$('crop-status').textContent='Сохраняем аватар…';
 await perform(async()=>{
 try{
  const output=document.createElement('canvas');let blob;
  // A noisy 256px PNG can exceed the cap. Keep the crop and lower resolution, never send an oversized body.
  for(const size of [256,224,192,160,128]){output.width=output.height=size;output.getContext('2d').drawImage(canvas,0,0,size,size);blob=await new Promise(resolve=>output.toBlob(resolve,'image/png'));if(blob&&blob.size<=MAX_OUTPUT_BYTES)break;}
  if(!blob||blob.size>MAX_OUTPUT_BYTES)throw new Error('Не удалось подготовить изображение. Попробуй другое фото.');
  await request('/api/me/avatar',{method:'PUT',blob,csrfToken:getMe().csrfToken});await onSaved();controlsDisabled(false);close();$('avatar-status').textContent='Аватар обновлён.';
 }catch(error){$('crop-status').textContent=error.code?errorMessage(error):error.message;controlsDisabled(false);}
 });
 });
 for(const button of $('avatar-choices').querySelectorAll('button'))button.addEventListener('click',()=>perform(async()=>{
 if(!getMe())return;
 await request('/api/me',{method:'PATCH',data:{avatar:button.dataset.avatar},csrfToken:getMe().csrfToken});await onSaved();$('avatar-status').textContent='Значок сохранён.';
 }));
 return {reset(){if(dialog.open&&!saving)close();else if(!saving)release();}};
}
