import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {activeReaderAccount} from '../../scripts/reader-account-state.mjs';

const MAX_LOG_BYTES=64*1024*1024;
// 按已有账号作用域隔离记录，换号时不会显示另一个账号的生成内容。
export function previewLogPath(root){
  const scope=activeReaderAccount(root).id;
  return path.join(root,'state',...(scope?['accounts',scope]:[]),'reply-previews.jsonl');
}
export function readReplyPreviews(root){
  const file=previewLogPath(root);if(!fs.existsSync(file))return [];
  if(fs.statSync(file).size>MAX_LOG_BYTES)throw Error('REPLY_PREVIEW_STORAGE_FULL');
  return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
export function appendReplyPreview(root,input){
  const file=previewLogPath(root),rows=readReplyPreviews(root),id=input.deliveryId||crypto.randomUUID();
  const key='wechat:'+input.kind+':'+input.target;
  if(rows.some(row=>row.id===id&&row.key===key))return id;
  const row={id,key,text:input.text??'[表情候选，未发送]',timestamp:Date.now()/1000,
    source:input.source??'reply',generated:true,outgoing:false,delivery_status:'preview',
    ...(input.stickerId?{sticker_id:input.stickerId}:{}),...(input.fileName?{file_name:input.fileName}:{})};
  const line=JSON.stringify(row)+'\n',size=Buffer.byteLength(line);
  if(size>128*1024)throw Error('REPLY_PREVIEW_TOO_LARGE');
  if((fs.existsSync(file)?fs.statSync(file).size:0)+size>MAX_LOG_BYTES)throw Error('REPLY_PREVIEW_STORAGE_FULL');
  fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'a',0o600);
  // 保存失败直接向上报告，不能退回真实发送，也不能将消息标成已送达。
  try{fs.writeFileSync(fd,line);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return id;
}
