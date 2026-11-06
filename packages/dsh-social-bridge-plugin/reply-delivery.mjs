import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {appendReplyPreview,readReplyPreviews} from './reply-preview-store.mjs';

const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const failure=code=>Object.assign(Error(code),{code});
export function replyDeliveryMode(config){
  const value=config.wechat?.replyDelivery;
  if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))throw failure('REPLY_MODE_INVALID');
  const mode=value?.mode??'send';
  if(!['send','preview'].includes(mode))throw failure('REPLY_MODE_INVALID');
  // 整体禁用发送；旧配置仅用于兼容读取，不能恢复 Hook。
  return 'preview';
}
export function readReplyMode(root){
  return replyDeliveryMode(JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'')));
}
export function createReplyPreview(root){
  return input=>{
    const mode=readReplyMode(root);
    if(!['private','group'].includes(input.kind)||!/^\d+$/.test(String(input.target)))throw failure('REPLY_PREVIEW_TARGET_INVALID');
    const key='wechat:'+input.kind+':'+input.target;
    const previous=input.deliveryId?readReplyPreviews(root).find(row=>row.id===input.deliveryId&&row.key===key):null;
    // 保留旧预览回执，避免重复生成记录。
    if(!previous&&mode!=='preview')return null;
    const id=previous?.id??appendReplyPreview(root,input);
    return {receipt:'local-preview',delivered:'preview',attempted:false,previewId:id};
  };
}
export function saveReplyMode(root,mode,revision){
  if(mode!=='preview')throw failure('HOOK_DISABLED');
  const file=path.join(root,'config/wechatagent.json'),raw=fs.readFileSync(file,'utf8');
  if(hash(raw)!==revision)throw failure('REPLY_MODE_CONFLICT');
  const config=JSON.parse(raw.replace(/^\uFEFF/,''));config.wechat.replyDelivery={mode};
  const backup=path.join(root,'state/console-backups/reply-mode-'+crypto.randomUUID()+'.json');
  fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,raw,{mode:0o600});
  const text=JSON.stringify(config,null,2)+'\n',temp=file+'.mode-'+crypto.randomUUID();
  try{fs.writeFileSync(temp,text,{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return {config,revision:hash(text),replyDeliveryMode:mode};
}
