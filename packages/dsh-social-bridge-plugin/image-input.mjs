import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {boundedTask} from './deadline.mjs';

export async function imageBlocks(ctx,root,conversationKey,images,provider,model,{onUnavailable,timeoutMs=25000,signal:parentSignal}={}) {
  if (!Array.isArray(images) || images.length>4) throw new Error('IMAGE_BATCH_LIMIT');
  if (!images.length) return [];
  if (images.some(image=>!/^[a-f0-9]{64}$/.test(image?.id ?? ''))) throw new Error('INVALID_IMAGE_REFERENCE');
  const llm=ctx.get('llm'), attachments=ctx.get('attachments');
  const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(parentSignal?[parentSignal]:[])]);
  const unavailableBlock=(image,index,error)=>{
    if(!onUnavailable)throw error;
    // Reject the image itself on binding/integrity/format failures too. Never
    // admit its bytes, and never leave that bad input at the head of the chat.
    const safeCode=/^(?:IMAGE_[A-Z_]+|INVALID_IMAGE_DATA|MODEL_IMAGE_INPUT_UNSUPPORTED)$/.test(error.message)?error.message:'IMAGE_READER_NOT_READY';
    const code=error.imageError??(error.name==='TimeoutError'||error.name==='AbortError'?'IMAGE_PROCESS_TIMEOUT':safeCode);
    onUnavailable({id:image.id,index,code});
    const reason=code==='MODEL_IMAGE_INPUT_UNSUPPORTED'
      ? '当前模型不支持图片输入；需要切换到支持图片的模型'
      : code==='IMAGE_PROCESS_TIMEOUT' ? '图片处理超时，可稍后重试'
      : ['IMAGE_LOCAL_COPY_UNAVAILABLE','IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE','IMAGE_LOCAL_FILE_MISSING'].includes(code)
        ? '本地图片尚不可用，可先在微信中打开原图后重发'
        : '本轮未能读取图片，可尝试重新发送';
    return {type:'text',text:`[本轮附图 I${index+1} 读取失败：${reason}。未提供画面，不要猜测内容。若影响回答对方的问题，应简短告知对方原因；不要只说已收到图片。其余成功附图和随附文字仍可正常回答。图库候选读取失败无需单独通知。]`};
  };
  let info;
  try{
    if (!llm || !attachments) throw new Error('NATIVE_IMAGE_SERVICES_UNAVAILABLE');
    info=await boundedTask(s=>llm.resolveModelInfo(provider,model,s),{timeoutMs,signal});
  }
  catch(error){return images.map((image,index)=>unavailableBlock(image,index,error));}
  if (!info.inputModalities?.includes('image')) return images.map((image,index)=>unavailableBlock(image,index,new Error('MODEL_IMAGE_INPUT_UNSUPPORTED')));
  let io,base;
  try {
    io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,''));
    base=new URL(io.reader_base_url);
    if (base.protocol!=='http:' || base.hostname!=='127.0.0.1' || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('IMAGE_READER_LOOPBACK_REQUIRED');
  } catch(error) { return images.map((image,index)=>unavailableBlock(image,index,error)); }
  const blocks=new Array(images.length);let next=0;
  async function prepare(image,index) {
    try {
    return await boundedTask(async taskSignal=>{
    const response=await fetch(base.origin+'/api/v1/images/'+image.id,{headers:{Authorization:'Bearer '+io.reader_token},redirect:'error',signal:taskSignal});
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = new Error('IMAGE_READER_NOT_READY');
      if (typeof failure.error === 'string' && /^IMAGE_[A-Z_]{3,80}$/.test(failure.error)) error.imageError = failure.error;
      throw error;
    }
    const content=await response.json();
    if (content.imageId!==image.id || content.conversationKey!==conversationKey) throw new Error('IMAGE_CONVERSATION_MISMATCH');
    if (typeof content.b64!=='string' || content.b64.length>1100000 || !['image/png','image/jpeg','image/webp'].includes(content.mime)) throw new Error('INVALID_IMAGE_DATA');
    const data=Buffer.from(content.b64,'base64');
    if (!data.length || data.length>768*1024 || data.toString('base64')!==content.b64 || crypto.createHash('sha256').update(data).digest('hex')!==content.sha256) throw new Error('IMAGE_INTEGRITY_FAILED');
    const attachment=await attachments.saveImage({data,mediaType:content.mime,name:'wechat-image-'+image.id.slice(0,12)});
    return {type:'image',attachment};
    },{timeoutMs:12000,signal});
    } catch(error) {
      return unavailableBlock(image,index,error);
    }
  }
  await Promise.all(Array.from({length:Math.min(2,images.length)},async()=>{
    while(next<images.length){const index=next++;blocks[index]=await prepare(images[index],index);}
  }));
  return blocks;
}

export function offloadCompletedImages(session,sourceSeqs) {
  const targets=[];
  for (const seq of sourceSeqs) {
    const event=session.eventAt(seq);
    const message=session.deriveEventMessage ? session.deriveEventMessage(event) : event.data;
    const imageIndexes=[];let index=0;
    for (const block of message.content ?? []) if(block.type==='image'){if(!block.offloaded)imageIndexes.push(index);index++;}
    if (imageIndexes.length) targets.push({seq,imageIndexes});
  }
  if(targets.length) session.append('image/offload',{targets});
}

export function offloadCompletedSessionImages(session) {
  // Failed/cancelled vision turns must release their image bytes too. Keeping
  // an invalid attachment active makes every later text request fail again.
  const completed=session.snapshotEvents().findLast(event=>event.type==='turn/end');
  if(!completed)return;
  const seqs=session.surface.nodes.filter(seq=>{
    const event=session.eventAt(seq);
    return seq<completed.seq && event.type==='user/message' && event.data.source?.socialImageIds?.length;
  });
  offloadCompletedImages(session,seqs);
}
