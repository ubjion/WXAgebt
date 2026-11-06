import {FileTransfers} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
const terminal=new Set(['confirmed','failed','unconfirmed','cancelled','expired']);
const rowKey=row=>JSON.stringify([row.localId,row.serverId,row.createTime]);
const safeError=error=>/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code??error?.message)?error.code??error.message:'FILE_DELIVERY_FAILED';
export class FileDeliveryWorker {
  constructor(adapter,{log=()=>{},pollMs=1000}={}){this.adapter=adapter;this.store=new FileTransfers(adapter.directory);this.log=log;this.pollMs=pollMs;this.running=new Set();this.targets=new Set();this.stopped=false;}
  save(job){this.store.write(job);this.log('[File] '+job.id.slice(0,12)+' state='+job.state+(job.error?' code='+job.error:''));}
  tick(){if(this.stopped||this.running.size>=2)return;for(const job of this.store.list().sort((a,b)=>a.createdAt-b.createdAt)){
    if(terminal.has(job.state)||this.running.has(job.id)||this.targets.has(job.key)||this.running.size>=2)continue;
    this.running.add(job.id);this.targets.add(job.key);void this.run(job).catch(error=>{job.state=job.state==='queued'?'failed':'unconfirmed';job.error=safeError(error);try{this.save(job);}catch{}}).finally(()=>{this.running.delete(job.id);this.targets.delete(job.key);});
  }}
  async run(job){
    if(terminal.has(job.state))return;
    const adapter=this.adapter;
    if(job.accountScope!==this.store.account()||!this.store.allowed(job.key,job.sender)){job.state='cancelled';job.error='FILE_ACCESS_CHANGED';this.save(job);return;}
    if(Date.now()>=job.deadlineAt){job.state=job.state==='queued'?'expired':'unconfirmed';job.error='FILE_DELIVERY_TIMEOUT';this.save(job);return;}
    const [,kind,target]=job.key.split(':');if(!['private','group'].includes(kind)||!/^\d+$/.test(target))throw Error('FILE_JOB_INVALID');
    const identity=await adapter.checkNative();const wxid=await adapter.resolveTarget(kind,target);
    if(job.wxid&&job.wxid!==wxid||job.account&&job.account!==identity.account)throw Error('FILE_ACCOUNT_CHANGED');
    if(job.state==='queued'){
      const source=this.store.staged(job),proof=await this.store.hash(source,AbortSignal.timeout(10000));if(proof.sha256!==job.sha256||proof.md5!==job.md5||proof.size!==job.size)throw Error('FILE_STAGED_INVALID');
      // 登录、账号、文件权限和内容校验仍照常执行，只取消尚未提交的发送。
      const preview=adapter.previewDelivery?.({kind,target,text:'[文件未发送] '+job.name,fileName:job.name,deliveryId:job.id,source:'file'});
      if(preview){job.state='cancelled';job.error='FILE_PREVIEW_ONLY';this.save(job);return;}
      throw Error('HOOK_DISABLED');
    }
    if(!Array.isArray(job.baseline)||job.baseline.length>500||!Number.isFinite(job.startedAt))throw Error('FILE_RECEIPT_STATE_INVALID');
    const baseline=new Set(job.baseline);
    // Receipt waits never hold the text/sticker sender's target lock.
    while(!this.stopped&&Date.now()<job.deadlineAt){
      if(!this.store.allowed(job.key,job.sender)||job.accountScope!==this.store.account()){job.state='unconfirmed';job.error='FILE_ACCESS_CHANGED_AFTER_SUBMISSION';this.save(job);return;}
      for(const row of await adapter.messages(wxid))if(row.isSend&&(row.localType===25769803825||row.localType===49&&row.fileKind==='appmsg-6')&&row.fileName===job.name&&row.fileSize===job.size&&(!row.fileMd5||row.fileMd5===job.md5)&&!baseline.has(rowKey(row))&&row.createTime>=Math.floor(job.startedAt/1000)-30&&/^\d+$/.test(String(row.serverId))&&BigInt(row.serverId)>0n){
        job.state='confirmed';job.receipt={messageId:String(row.localId),type:'wechat-file',serverConfirmed:true};delete job.error;this.save(job);adapter.status.confirmed_sends++;return;
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(this.pollMs,Math.max(1,job.deadlineAt-Date.now()))));
    }
    if(!this.stopped){job.state='unconfirmed';job.error='FILE_DELIVERY_TIMEOUT';this.save(job);}
  }
  stop(){this.stopped=true;}
}
