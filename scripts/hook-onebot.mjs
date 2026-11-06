import fs from 'node:fs';
import {createReplyPreview,readReplyMode} from '../packages/dsh-social-bridge-plugin/reply-delivery.mjs';
import path from 'node:path';
import { PAT_TYPE, FORWARD_TYPE, QUOTE_TYPE, normalizeForwardedRecord, normalizeQuoteReply } from '../components/qq-bridge/src/core/wechat-events.js';
import { stickerPolicy, cleanStickerLabel } from '../components/qq-bridge/src/core/sticker-policy.js';
import {FileDeliveryWorker} from './file-delivery-worker.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import {verifyWeChatAccount} from './wechat-account-check.mjs';
import {readerAccountDirectory} from './reader-account-state.mjs';
import {proactivePolicy,withinProactiveWindow,conversationSnapshot,declinedProactive} from '../components/qq-bridge/src/core/proactive-policy.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const onebotId = value => Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);
export const conversationId = (wxid, name, mappedId) => {
  if(mappedId!==undefined){
    if(!/^[1-9]\d*$/.test(String(mappedId))||!Number.isSafeInteger(Number(mappedId)))throw new Error('INVALID_CONVERSATION_ID');
    return Number(mappedId);
  }
  return onebotId(wxid.includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid);
};
class AdapterError extends Error { constructor(code,data) { super(code); this.name = 'AdapterError';this.data=data; } }
const fail = code => { throw new AdapterError(code); };
const cleanAccountId = value => String(value ?? '').replace(/_[a-zA-Z0-9]{4}$/, '');
const systemErrorCode = error => {
  for(let current=error,depth=0;current&&depth<4;current=current.cause,depth++)if(typeof current.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(current.code))return current.code;
  return undefined;
};
function startupError(code,cause,stage,port){
  const error=new AdapterError(code);error.cause=cause;error.startup={stage,...(Number.isInteger(port)?{port}:{})};return error;
}
function healthError(error,prefix,stage,endpoint){
  let port;try{port=Number(new URL(endpoint).port||80);}catch{}
  if(error instanceof AdapterError){error.startup??={stage,...(Number.isInteger(port)?{port}:{})};return error;}
  const code=systemErrorCode(error);
  const reason=code==='ECONNREFUSED'?'NOT_LISTENING':error?.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ABORT_ERR'].includes(code)?'HEALTH_TIMEOUT':error instanceof SyntaxError?'HEALTH_INVALID_RESPONSE':['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code)?'CONNECTION_RESET':'HEALTH_FAILED';
  return startupError(prefix+'_'+reason,error,stage,port);
}
export function adapterStartupMessage(error,{checkOnly=false,stage='configuration',port}={}){
  const code=error instanceof AdapterError&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)?error.message:'ADAPTER_START_FAILED';
  const details=error?.startup??{},phase=details.stage??stage,number=details.port??(phase==='adapter-port-bind'?port:undefined),system=systemErrorCode(error);
  return (checkOnly?'Local account check failed: ':'Adapter startup failed: ')+code+' stage='+phase+(Number.isInteger(number)?' port='+number:'')+(system?' system='+system:'');
}

export function textSegments(message, maxBytes=16000) {
  if (typeof message === 'string') {
    // Raw OneBot strings may contain CQ segments. This sender only accepts text.
    if (/\[CQ:/i.test(message)) fail('TEXT_SEGMENTS_REQUIRED');
    message = [{ type: 'text', data: { text: message } }];
  }
  if (!Array.isArray(message) || !message.length || message.some(s => s?.type !== 'text' || typeof s.data?.text !== 'string')) fail('TEXT_ONLY');
  const text = message.map(s => s.data.text).join('');
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > maxBytes) fail('INVALID_TEXT');
  return text;
}

export class HookOneBot {
  constructor({ directory = root, fetchImpl = fetch, accountVerifier = verifyWeChatAccount, receiptTimeoutMs, pollMs = 400 } = {}) {
    this.directory = directory;
    this.previewDelivery=createReplyPreview(directory);
    this.fetch = fetchImpl;
    this.accountVerifier = accountVerifier;
    this.receiptOverride = receiptTimeoutMs;
    this.pollMs = pollMs;
    this.socket = null;
    this.stopped = false;
    this.controllers = new Set();
    this.pending = [];
    this.seen = new Map();
    this.targetsSending = new Set();
    this.textDeliveries=new TextDeliveryStore(path.join(directory,'state/text-deliveries'));
    this.stickerPending = new Map();
    this.stickerStateFile=path.join(directory,'state/sticker-delivery-pending.json');
    if(fs.existsSync(this.stickerStateFile)){
      const state=read(this.stickerStateFile);
      if(state.version!==1 || !Array.isArray(state.attempts))fail('STICKER_DELIVERY_STATE_INVALID');
      for(const [key,attempt] of state.attempts)this.stickerPending.set(key,{...attempt,baseline:new Set(attempt.baseline)});
    }
    this.activeActions = 0;this.fileWorker=new FileDeliveryWorker(this,{log:line=>console.log(new Date().toISOString(),line)});
    this.status = { backend: 'database-only', project:'WeChatAgent',component:'adapter',statusVersion:1,pid:process.pid,projectRoot:path.resolve(directory),ready:false,ob_connected: false, reader_connected: false,
      hook_connected: false, hook_account_verified: false, account_verified:false, received: 0, confirmed_sends: 0,
      failed_sends: 0, last_error: '', version: '' };
    this.reload();
  }
  reload() {
    this.project = read(path.join(this.directory, 'config', 'wechatagent.json'));
    this.api = read(path.join(this.directory, 'state', 'wechat-io-config.json'));
    if (this.project.runtime.weflowMode !== 'nt') fail('DATABASE_NT_CONFIG_REQUIRED');
  }
  allowed(kind, target) { return this.project.wechat.whitelist[kind === 'group' ? 'groups' : 'private'].map(String).includes(String(target)); }
  async json(base, route, options = {}, timeout = 4000) {
    const response = await this.fetch(base.replace(/\/$/, '') + route, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) fail('API_HTTP_' + response.status);
    const result = await response.json();
    if (result?.success === false) fail('READER_NOT_READY');
    return result;
  }
  reader(route) { return this.json(this.api.reader_base_url, route, { headers: { Authorization: 'Bearer ' + this.api.reader_token } }); }
  native() {
    // 全局阻断所有原生 HTTP 调用，包括健康检测，不能由旧配置重新启用。
    throw new AdapterError('HOOK_DISABLED',{rejected:true,attempted:false});
  }
  async checkNative() {
    // 保留方法名供旧调用方兼容；实现仅查询读取服务与系统文件占用证明。
    this.status.account_verified=false;this.status.hook_connected=false;this.status.hook_account_verified=false;
    this.startupStage='reader-status';
    const reader=await this.reader('/api/v1/reader/status').catch(error=>{throw healthError(error,'READER','reader-status',this.api.reader_base_url);});
    if(!reader||reader.backend!=='weflow-cli-nt'||!reader.ownWxid||!reader.accountDirectory)fail('READER_ACCOUNT_METADATA_REQUIRED');
    const settings=read(path.join(this.directory,'state/weflow/WeFlow-config.json'));
    const directory=readerAccountDirectory(this.directory,settings);
    if(!directory||path.basename(directory).toLowerCase()!==reader.accountDirectory.toLowerCase()||cleanAccountId(reader.ownWxid).toLowerCase()!==cleanAccountId(settings.myWxid).toLowerCase())fail('WECHAT_ACCOUNT_MISMATCH');
    this.startupStage='local-account-check';
    let identity;
    try{identity=await this.accountVerifier({root:this.directory,config:this.project,settings,wait:false,requireReady:true});}
    catch(error){fail(/^WECHAT_[A-Z_]+$/.test(error.code??error.message)?error.code??error.message:'WECHAT_ACCOUNT_PROBE_FAILED');}
    if(identity?.ready!==true)fail('WECHAT_LOGIN_REQUIRED');
    if(JSON.stringify(read(path.join(this.directory,'state/weflow/WeFlow-config.json')))!==JSON.stringify(settings))fail('WECHAT_ACCOUNT_MISMATCH');
    const after=await this.reader('/api/v1/reader/status');
    if(after.ownWxid!==reader.ownWxid||after.accountDirectory!==reader.accountDirectory)fail('WECHAT_ACCOUNT_MISMATCH');
    this.ownWxid=reader.ownWxid;this.status.account_verified=true;
    this.status.native_sticker_send=false;this.status.native_file_send=false;this.status.fileTransfer='local-preview-only';
    return {account:reader.accountDirectory.toLowerCase(),selfId:onebotId(reader.ownWxid)};
  }
  async waitForNative({timeoutMs=35000,intervalMs=250,onWaiting=()=>{}}={}) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isFinite(intervalMs)||intervalMs<1)fail('INVALID_ACCOUNT_WAIT');
    const deadline=Date.now()+timeoutMs;let notified=false;
    for(;;){
      try{return await this.checkNative();}
      catch(error){
        if(!(error instanceof AdapterError)||!['WECHAT_NOT_RUNNING','WECHAT_LOGIN_REQUIRED'].includes(error.message))throw error;
        if(Date.now()>=deadline){throw error;}
        if(!notified){notified=true;onWaiting(error.message);}
        await new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,Math.max(1,deadline-Date.now()))));
      }
    }
  }
  async resolveTarget(kind, target) {
    const data = await this.reader('/api/v1/sessions?limit=500');
    const matches = (data.sessions ?? []).filter(s => s.username &&
      (s.username.includes('@chatroom') ? 'group' : 'private') === kind &&
      String(conversationId(s.username, s.displayName, s.conversationId)) === String(target));
    if (matches.length !== 1 || matches[0].username === this.ownWxid) fail('TARGET_MAPPING_AMBIGUOUS_OR_MISSING');
    return matches[0].username;
  }
  async messages(wxid) {
    const result = await this.reader('/api/v1/messages?talker=' + encodeURIComponent(wxid) + '&limit=100');
    if (!Array.isArray(result.messages)) fail('INVALID_RECEIPT_RESPONSE');
    return result.messages;
  }
  async send(kind,target,text,deliveryId,proactive) {
    this.reload();if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    const identity=await this.checkNative(),wxid=await this.resolveTarget(kind,target);
    const operation=this.textDeliveries.key(kind,target,deliveryId,text),prior=this.textDeliveries.get(operation);
    if(prior){
      if(prior.account!==identity.account||prior.wxid!==wxid)fail('TEXT_DELIVERY_ACCOUNT_MISMATCH');
      if(prior.text!==text)fail('TEXT_DELIVERY_ID_CONFLICT');
      if(prior.state==='confirmed')return {...prior.response,reused:true};
      // 历史已提交或状态不明的消息不能重新标记为“未发送”。
      if(prior.state!=='rejected')throw new AdapterError('TEXT_DELIVERY_UNCONFIRMED',{attempted:true,delivery_id:deliveryId??operation});
    }
    if(proactive)this.assertProactive(kind,target,await this.messages(wxid),proactive,identity,wxid);
    return this.previewDelivery({kind,target,text,deliveryId,source:proactive?'proactive':'reply'});
  }
  assertProactive(kind,target,currentRows,proactive,identity,wxid){
    this.reload();const conversation='wechat:'+kind+':'+target,policy=proactivePolicy(this.project.wechat,conversation);
    if(!policy.enabled||!withinProactiveWindow(Date.now(),policy))fail('PROACTIVE_NOT_ALLOWED');
    const saved=fs.existsSync(path.join(this.directory,'state/social-messages.json'))?read(path.join(this.directory,'state/social-messages.json')):{chats:{}};
    let preceding;
    if(proactive.precedingDeliveryId){
      preceding=this.textDeliveries.get(this.textDeliveries.key(kind,target,proactive.precedingDeliveryId,''));
      if(preceding?.state!=='confirmed'||preceding.account!==identity.account||preceding.wxid!==wxid||preceding.text.startsWith('[STICKER:'))fail('INVALID_PROACTIVE_CONTEXT');
    }
    const rows=saved.chats?.[conversation]??[];
    if(saved.pendingReplies?.[conversation]||declinedProactive(rows)||conversationSnapshot(rows)!==proactive.contextId||
      currentRows.some(row=>Number(row.createTime)*1000>Date.now()-policy.idleMinutes*60000&&
        !(preceding&&row.isSend&&String(row.localId)===String(preceding.response.message_id)&&String(row.fullText??row.content??row.parsedContent??'').trim()===preceding.text.trim())))fail('PROACTIVE_CONTEXT_CHANGED');
  }
  async stickerList(kind,target,query){
    this.reload();
    if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    if(!stickerPolicy(this.project.wechat,'wechat:'+kind+':'+target).enabled)return {enabled:false,stickers:[]};
    await this.checkNative();
    const key='wechat:'+kind+':'+target;
    const result=await this.reader('/api/v1/stickers?conversationKey='+encodeURIComponent(key)+(typeof query==='string'&&query.trim()?'&query='+encodeURIComponent(query.slice(0,500)):''));
    return {enabled:true,stickers:(result.stickers??[]).filter(item=>/^[a-f0-9]{64}$/.test(item?.id??'')).slice(0,20).map(item=>({id:item.id,receivedAt:item.receivedAt,...(cleanStickerLabel(item)??{})}))};
  }
  async stickerLabels(kind,target,params){
    this.reload();if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    const policy=stickerPolicy(this.project.wechat,'wechat:'+kind+':'+target);
    if(!policy.labelCache)return {labels:[],saved:0};
    const result=await this.json(this.api.reader_base_url,'/api/v1/stickers/labels',{method:'POST',headers:{Authorization:'Bearer '+this.api.reader_token,'Content-Type':'application/json'},body:JSON.stringify({...params,conversationKey:'wechat:'+kind+':'+target})});
    return result;
  }
  persistStickerPending(){
    const temp=this.stickerStateFile+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({version:1,attempts:[...this.stickerPending].map(([key,item])=>[key,{...item,baseline:[...item.baseline]}])}),{mode:0o600});
    fs.renameSync(temp,this.stickerStateFile);
  }
  async sendSticker(kind,target,id,deliveryId,proactive,receiptOnly=false,deferReceipt=false,deadlineAt,abandon=false){
    this.reload();if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    if(!/^[a-f0-9]{64}$/.test(id))fail('INVALID_STICKER_REFERENCE');
    const identity=await this.checkNative(),wxid=await this.resolveTarget(kind,target);
    const prior=deliveryId?this.textDeliveries.get(this.textDeliveries.key(kind,target,deliveryId,'[STICKER:'+id+']')):null;
    if(prior){
      if(prior.account!==identity.account||prior.wxid!==wxid)fail('TEXT_DELIVERY_ACCOUNT_MISMATCH');
      if(prior.text!=='[STICKER:'+id+']')fail('TEXT_DELIVERY_ID_CONFLICT');
      if(prior.state==='confirmed')return {...prior.response,reused:true};
      fail('STICKER_DELIVERY_UNCONFIRMED');
    }
    const pending=this.stickerPending.get(kind+':'+target);
    if(pending?.deliveryId===deliveryId&&pending?.id===id)fail('STICKER_DELIVERY_UNCONFIRMED');
    if(abandon||receiptOnly)fail('STICKER_RECEIPT_STATE_UNAVAILABLE');
    if(!stickerPolicy(this.project.wechat,'wechat:'+kind+':'+target).enabled)fail('STICKER_SENDING_DISABLED');
    if(deadlineAt!==undefined&&Date.now()>=deadlineAt)fail('STICKER_DELIVERY_EXPIRED');
    if(proactive)this.assertProactive(kind,target,await this.messages(wxid),proactive,identity,wxid);
    return this.previewDelivery({kind,target,stickerId:id,deliveryId});
  }
  async action(request) {
    const response = { status: 'failed', retcode: 1407, data: {}, ...(request?.echo === undefined ? {} : { echo: request.echo }) };
    this.activeActions++;
    try {
      if (this.activeActions > 8) fail('SENDER_BUSY');
      this.reload();
      const action = request?.action, params = request?.params ?? {};
      let data;
      if (['send_msg', 'send_private_msg', 'send_group_msg'].includes(action)) {
        const kind = action === 'send_group_msg' || (action === 'send_msg' && params.message_type === 'group') ? 'group' : 'private';
        if (action === 'send_msg' && !['group', 'private'].includes(params.message_type)) fail('MESSAGE_TYPE_REQUIRED');
        const target = String(params[kind === 'group' ? 'group_id' : 'user_id'] ?? '');
        if (!/^\d+$/.test(target) || !this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
        const deliveryId=params.wechatagent_delivery_id;
        if(deliveryId!==undefined&&!/^[a-f0-9]{64}$/.test(deliveryId))fail('INVALID_DELIVERY_ID');
        if(params.wechatagent_receipt_only!==undefined&&typeof params.wechatagent_receipt_only!=='boolean')fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_defer_receipt!==undefined&&typeof params.wechatagent_defer_receipt!=='boolean')fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_abandon_delivery!==undefined&&(typeof params.wechatagent_abandon_delivery!=='boolean'||params.wechatagent_abandon_delivery&&(!deliveryId||params.wechatagent_receipt_only!==true)))fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_deadline_at!==undefined&&(!Number.isSafeInteger(params.wechatagent_deadline_at)||params.wechatagent_deadline_at<0||params.wechatagent_deadline_at>Date.now()+60000))fail('INVALID_DELIVERY_DEADLINE');
        if(params.wechatagent_receipt_only===true&&(!deliveryId||!Array.isArray(params.message)||params.message.length!==1||params.message[0]?.type!=='wechat_sticker'))fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_source!==undefined&&params.wechatagent_source!=='proactive')fail('INVALID_SEND_SOURCE');
        if(params.wechatagent_source==='proactive'&&(!deliveryId||!/^[a-f0-9]{64}$/.test(params.wechatagent_context_id??'')||
          params.wechatagent_preceding_delivery_id!==undefined&&!/^[a-f0-9]{64}$/.test(params.wechatagent_preceding_delivery_id)))fail('INVALID_PROACTIVE_CONTEXT');
        const proactive=params.wechatagent_source==='proactive'?{contextId:params.wechatagent_context_id,...(params.wechatagent_preceding_delivery_id?{precedingDeliveryId:params.wechatagent_preceding_delivery_id}:{})}:null;
        if(Array.isArray(params.message)&&params.message.length===1&&params.message[0]?.type==='wechat_sticker'){
          data=await this.sendSticker(kind,target,String(params.message[0].data?.id??''),deliveryId,proactive,params.wechatagent_receipt_only===true,params.wechatagent_defer_receipt===true,params.wechatagent_deadline_at,params.wechatagent_abandon_delivery===true);
        }else{
          const text=textSegments(params.message,readReplyMode(this.directory)==='preview'?128*1024:16000);
          data=await this.send(kind,target,text,deliveryId,proactive);
        }
      } else if(['get_sticker_list','get_sticker_labels','save_sticker_labels'].includes(action)){
        const kind=params.kind,target=String(params.target??'');
        if(!['group','private'].includes(kind)||!/^\d+$/.test(target))fail('INVALID_STICKER_TARGET');
        data=action==='get_sticker_list'?await this.stickerList(kind,target,params.query):await this.stickerLabels(kind,target,{operation:action==='get_sticker_labels'?'read':'save',...(action==='get_sticker_labels'?{ids:params.ids}:{labels:params.labels})});
      } else if (action === 'get_status') {
        data = { online: this.status.account_verified, good: this.status.account_verified && this.status.reader_connected };
      } else if (action === 'get_version_info') {
        data = { app_name: 'WeChatAgent-Database-Only', app_version: '1', protocol_version: 'v11' };
      } else if (action === 'get_login_info') {
        data = { user_id: (await this.checkNative()).selfId, nickname: this.project.account.nicknames[0] };
      } else if (['get_friend_list', 'get_group_list'].includes(action)) {
        const kind = action === 'get_group_list' ? 'group' : 'private';
        const sessions = (await this.reader('/api/v1/sessions?limit=500')).sessions ?? [];
        data = sessions.filter(s => s.username && (s.username.includes('@chatroom') ? 'group' : 'private') === kind)
          .map(s => ({ id: conversationId(s.username, s.displayName, s.conversationId), name: s.displayName ?? s.username }))
          .filter(s => this.allowed(kind, s.id)).map(s => kind === 'group' ? { group_id: s.id, group_name: s.name } : { user_id: s.id, nickname: s.name, remark: s.name });
      } else fail('ACTION_UNSUPPORTED');
      return { ...response, status: 'ok', retcode: 0, data };
    } catch (error) {
      const code = error instanceof AdapterError ? error.message : error?.message==='TEXT_DELIVERY_STATE_INVALID'?'TEXT_DELIVERY_STATE_INVALID':'BACKEND_UNAVAILABLE';
      this.status.last_error = code;
      if (String(request?.action).startsWith('send_')) this.status.failed_sends++;
      return { ...response, data:error instanceof AdapterError&&error.data?error.data:{},retcode: code === 'ACTION_UNSUPPORTED' ? 1404 : 1407, message: code };
    } finally { this.activeActions--; }
  }
  incoming(payload) {
    this.reload();
    if (payload?.event !== 'message.new' || ![1,3,47,PAT_TYPE,49,FORWARD_TYPE,QUOTE_TYPE,25769803825].includes(payload.type) || typeof payload.content !== 'string' || !payload.content.trim() || !payload.sessionId || !payload.talkerId || payload.isSend || payload.talkerId === this.ownWxid) return null;
    const forwardedRecord=[49,FORWARD_TYPE].includes(payload.type)?normalizeForwardedRecord(payload.forwardedRecord):null;
    const quoteReply=[49,QUOTE_TYPE].includes(payload.type)?normalizeQuoteReply(payload.quoteReply):null;
    if([49,FORWARD_TYPE,QUOTE_TYPE].includes(payload.type) && (!forwardedRecord && !quoteReply || forwardedRecord && quoteReply))return null;
    if ([3,47].includes(payload.type) && !/^[a-f0-9]{64}$/.test(payload.image?.id ?? '')) return null;
    if(payload.type===25769803825&&(!/^[a-f0-9]{64}$/.test(payload.file?.id??'')||typeof payload.file?.name!=='string'||!Number.isSafeInteger(payload.file?.size)||payload.file.size<0||payload.file.size>50*1024*1024))return null;
    if (payload.type === PAT_TYPE && (!this.ownWxid || payload.pat?.target !== cleanAccountId(this.ownWxid) || payload.pat?.actor !== payload.talkerId || payload.pat.actor === cleanAccountId(this.ownWxid))) return null;
    const group = payload.sessionId.includes('@chatroom'), kind = group ? 'group' : 'private';
    const target = conversationId(payload.sessionId, payload.groupName, payload.conversationId);
    if (!this.allowed(kind, target)) return null;
    if(!group && payload.talkerId!==payload.sessionId)return null;
    const selfId = onebotId(this.ownWxid), userId = onebotId(group ? payload.talkerId : payload.sessionId);
    if(quoteReply){
      const ref=quoteReply.reference;
      const sameChat=group?ref.conversationId===payload.sessionId:!ref.conversationId;
      ref.senderRelation=sameChat && ref.senderId && this.ownWxid
        ? cleanAccountId(ref.senderId)===cleanAccountId(this.ownWxid)?'self':'other':'unknown';
    }
    const content=quoteReply?(quoteReply.reply||'[引用回复，正文为空]'):payload.content;
    // A WeChat mention label is an address, not a name/persona instruction.
    // Keep its wake-up segment while excluding only our configured labels
    // from model-visible text; other mentions and ordinary body text stay intact.
    let modelContent=content,selfMention=false;
    if(group){
      const names=(this.project.account?.nicknames??[]).filter(name=>typeof name==='string'&&name.length)
        .sort((a,b)=>b.length-a.length).map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
      if(names.length)modelContent=content.replace(new RegExp('@(?:'+names.join('|')+')(?=[\\s\\u2005]|$)[ \\t\\u2005]*','g'),()=>{selfMention=true;return '';}).trim();
      if(selfMention&&!modelContent)modelContent='[有人@你]';
      if(selfMention&&quoteReply)quoteReply.reply=modelContent;
    }
    const segments = [{ type: 'text', data: { text: modelContent } }];
    if(payload.type===25769803825)segments.push({type:'file',data:{id:payload.file.id,name:payload.file.name,size:payload.file.size}});
    if ([3,47].includes(payload.type)) segments.push({type:'image',data:{file:'wechatagent://image/'+payload.image.id,media_id:payload.image.id,...(payload.type===47?{media_kind:'sticker'}:{})}});
    if (selfMention) segments.unshift({ type: 'at', data: { qq: String(selfId) } });
    return { time: payload.timestamp || Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'message',
      message_type: kind, sub_type: group ? 'normal' : 'friend', message_id: payload.rawid,
      user_id: userId, message: segments, raw_message: content,
      sender: { user_id: userId, nickname: payload.sourceName || payload.senderName || String(userId) },
      ...({wechatagent:{senderWxid:payload.talkerId,...(group?{memberId:crypto.createHash('sha256').update('wechat-member:'+payload.talkerId).digest('hex')}:{}),...(payload.type===PAT_TYPE?{interaction:'pat'}:forwardedRecord?{forwardedRecord}:quoteReply?{quoteReply}:{})}}),
      ...(group ? { group_id: target, group_name: payload.groupName || String(target) } : {}) };
  }
  async enqueue(payload) {
    await this.checkNative();
    const event = this.incoming(payload);
    if (!event || !event.message_id || this.seen.has(event.message_id)) return;
    if (this.pending.length >= 200) fail('EVENT_QUEUE_FULL');
    this.pending.push(event); this.seen.set(event.message_id, true);
    while (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
    this.status.received++; this.flush();
  }
  flush() {
    while (this.status.account_verified && this.socket?.readyState === WebSocket.OPEN && this.pending.length) {
      const event = this.pending[0];
      // Recheck removed whitelist entries before forwarding buffered events.
      this.reload();
      if (this.allowed(event.message_type, event.message_type === 'group' ? event.group_id : event.user_id)) {
        try { this.socket.send(JSON.stringify(event)); } catch { return; }
      }
      this.pending.shift();
    }
  }
  async connectOneBot() {
    while (!this.stopped) {
      const socket = new WebSocket(this.api.onebot_ws_url);
      this.socket = socket;
      await new Promise(resolve => {
        const connectTimer = setTimeout(() => socket.close(), 8000);
        socket.addEventListener('open', () => {
          clearTimeout(connectTimer); this.status.ob_connected = true;
          socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: onebotId(this.ownWxid), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
          try { this.flush(); } catch { this.status.last_error = 'CONFIG_INVALID'; }
        });
        socket.addEventListener('message', async event => {
          let request;
          try { request = JSON.parse(String(event.data)); } catch { return; }
          if (!request || typeof request !== 'object' || Array.isArray(request)) return;
          const response = await this.action(request);
          if (socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify(response)); } catch {} }
        });
        socket.addEventListener('error', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
        socket.addEventListener('close', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
      });
      socket.close(); this.status.ob_connected = false;
      if (!this.stopped) await sleep(1500);
    }
  }
  async receiveSse() {
    while (!this.stopped) {
      const controller = new AbortController(); this.controllers.add(controller);
      let watchdog = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await this.fetch(this.api.reader_base_url + '/api/v1/push/messages', {
          headers: { Authorization: 'Bearer ' + this.api.reader_token }, signal: controller.signal, redirect: 'error',
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) fail('READER_STREAM_UNAVAILABLE');
        this.status.reader_connected = true;
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 35000);
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 256000) fail('READER_EVENT_TOO_LARGE');
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at).trimEnd(); buffer = buffer.slice(at + 1);
            if (line.startsWith('data:')) await this.enqueue(JSON.parse(line.slice(5)));
          }
          if (this.stopped) break;
        }
      } catch { if (!this.stopped) this.status.last_error = 'READER_STREAM_UNAVAILABLE'; }
      finally { clearTimeout(watchdog); controller.abort(); this.controllers.delete(controller); this.status.reader_connected = false; }
      if (!this.stopped) await sleep(1500);
    }
  }
  async start() {
    await this.checkNative();
    this.server = http.createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(this.status));
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>WeChatAgent</title><h1>WeChatAgent · 仅生成</h1><p>OneBot v11 · 本机生成，不发送</p><pre id="status">加载中</pre><script>async function update(){try{document.getElementById("status").textContent=JSON.stringify(await(await fetch("/status")).json(),null,2)}catch{document.getElementById("status").textContent="状态服务未连接"}}update();setInterval(update,2000)</script>');
      } else { res.writeHead(404); res.end(); }
    });
    this.startupStage='adapter-port-bind';
    try{await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.project.ports.adapter, '127.0.0.1', resolve); });}
    catch(error){const code=systemErrorCode(error);throw startupError(code==='EADDRINUSE'?'ADAPTER_PORT_IN_USE':['EACCES','EPERM'].includes(code)?'ADAPTER_PORT_DENIED':'ADAPTER_LISTEN_FAILED',error,'adapter-port-bind',this.project.ports.adapter);}
    this.status.ready=true;
    this.tasks = [this.connectOneBot(), this.receiveSse()];
    this.fileTimer=setInterval(()=>{try{this.fileWorker.tick();}catch{}},1000);this.fileTimer.unref();
    let checking = false;
    this.healthTimer = setInterval(async () => {
      if (checking || this.stopped) return;
      checking = true;
      try { await this.checkNative(); }
      catch (error) { this.status.last_error = error instanceof AdapterError ? error.message : 'BACKEND_UNAVAILABLE'; }
      finally { checking = false; }
    }, 5000);
    console.log('Database-only OneBot v11 adapter ready; local account verified; Hook disabled.');
  }
  async stop() {
    this.stopped = true;this.status.ready=false; for (const controller of this.controllers) controller.abort();
    clearInterval(this.healthTimer);clearInterval(this.fileTimer);this.fileWorker.stop();
    this.socket?.close();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    await Promise.allSettled(this.tasks ?? []);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let adapter;
  try {
    adapter = new HookOneBot();
    if (process.argv.includes('--check')) {
      await adapter.waitForNative({onWaiting:()=>console.log('Waiting for local WeChat account database ownership...')}); console.log('Selected account database ownership verified without Hook.');
    } else {
      await adapter.start();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await adapter.stop(); process.exit(0); });
    }
  } catch (error) { console.error(adapterStartupMessage(error,{checkOnly:process.argv.includes('--check'),stage:adapter?.startupStage,port:adapter?.project?.ports?.adapter})); process.exitCode = 1; }
}
