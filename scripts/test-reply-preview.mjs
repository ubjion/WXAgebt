import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HookOneBot} from './hook-onebot.mjs';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {readReplyPreviews,previewLogPath} from '../packages/dsh-social-bridge-plugin/reply-preview-store.mjs';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';

function fixture(t,{mode='preview',mismatch=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preview-login-')),config={runtime:{sender:'database-only',weflowMode:'nt'},hook:{baseUrl:'http://127.0.0.1:30001',expectedVersion:'4.1.10.27',receiptTimeoutMs:1000},ports:{adapter:0},wechat:{replyDelivery:{mode},whitelist:{private:['123'],groups:[]}}};
 const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 const save=()=>write('config/wechatagent.json',config);save();write('state/wechat-io-config.json',{reader_base_url:'http://127.0.0.1:5031',reader_token:'fixture'});write('state/hook/native-token.txt','a'.repeat(64));
 const calls=[];let sentText,submissions=0;
 write('state/weflow/WeFlow-config.json',{dbPath:path.join(root,'wxid_fixture'),myWxid:'wxid_fixture'});fs.mkdirSync(path.join(root,'wxid_fixture/db_storage'),{recursive:true});
 const hook=new HookOneBot({directory:root,pollMs:1,accountVerifier:async()=>{if(mismatch)throw Object.assign(Error('WECHAT_ACCOUNT_MISMATCH'),{code:'WECHAT_ACCOUNT_MISMATCH'});return {ready:true};},fetchImpl:async(input,options={})=>{
  const url=new URL(input);calls.push(url.pathname);
  let data={};if(url.pathname==='/api/v1/reader/status')data={backend:'weflow-cli-nt',ownWxid:'wxid_fixture',accountDirectory:'wxid_fixture'};
  else if(url.pathname==='/WeChatAgent/health')data={backend:'wechat-hook',integration:'WeChatAgent-1',version:'4.1.10.27',databaseAccounts:[mismatch?'other':'wxid_fixture'],nativeStickerSend:true,nativeFileSend:true};
  else if(url.pathname==='/api/v1/sessions')data={sessions:[{username:'wxid_friend',conversationId:123,displayName:'测试好友'}]};
  else if(url.pathname==='/SendTextMsg'){submissions++;sentText=JSON.parse(options.body).msg;data={ret:0};}
  else if(url.pathname==='/api/v1/messages')data={messages:sentText?[{isSend:true,localType:1,localId:1,serverId:'999',createTime:Math.floor(Date.now()/1000),fullText:sentText}]:[]};
  return new Response(JSON.stringify(data));
 }});
 const adapter=new WechatOneBotAdapter();adapter.server.action=async(action,params)=>{const r=await hook.action({action,params});if(r.retcode!==0)throw Object.assign(Error(r.message),{code:r.message,data:r.data});return r;};
 t.after(()=>{hook.fileWorker.stop();fs.rmSync(root,{recursive:true,force:true});});
 return {root,config,save,hook,adapter,calls,get submissions(){return submissions;}};
}
test('preview retains existing login checks and stores a deduplicated unsent result',async t=>{
 const f=fixture(t),input={kind:'private',target:'123',text:'仅保存在本机',deliveryId:'b'.repeat(64)};
 assert.equal((await f.adapter.sendText(input)).delivered,'preview');await f.adapter.sendText(input);
 assert.equal(f.submissions,0);assert(!f.calls.includes('/WeChatAgent/health'));assert(f.calls.includes('/api/v1/reader/status'));assert.equal(readReplyPreviews(f.root).length,1);assert.equal(f.adapter.stats.sends,0);assert.equal(f.hook.status.confirmed_sends,0);
});
test('preview cannot bypass a login account mismatch',async t=>{
 const f=fixture(t,{mismatch:true});await assert.rejects(f.adapter.sendText({kind:'private',target:'123',text:'禁止绕过'}),/WECHAT_ACCOUNT_MISMATCH/);assert.equal(f.submissions,0);assert.equal(readReplyPreviews(f.root).length,0);
});
test('legacy normal mode cannot enable native submission',async t=>{
 const f=fixture(t,{mode:'send'}),r=await f.adapter.sendText({kind:'private',target:'123',text:'模拟发送',deliveryId:'c'.repeat(64)});assert.equal(r.delivered,'preview');assert.equal(f.submissions,0);assert.equal(readReplyPreviews(f.root).length,1);assert.equal(f.adapter.stats.sends,0);
});
test('preview sticker and final native guard never invoke a Send HTTP endpoint',async t=>{
 const f=fixture(t);assert.equal((await f.adapter.sendSticker({kind:'private',target:'123',id:'d'.repeat(64),deliveryId:'e'.repeat(64)})).delivered,'preview');
 for(const route of ['/SendTextMsg','/SendStickerMsg','/SendFileMsg'])assert.throws(()=>f.hook.native(route,{}),/HOOK_DISABLED/);
 assert(!f.calls.some(p=>p.startsWith('/Send')));assert.equal(f.adapter.stats.sends,0);
});
test('save failure does not fall back to sending',async t=>{
 const f=fixture(t),file=previewLogPath(f.root);fs.mkdirSync(file,{recursive:true});await assert.rejects(f.adapter.sendText({kind:'private',target:'123',text:'不许补发'}));assert.equal(f.submissions,0);
});
test('a real engine completes a generated reply without an outgoing row',async t=>{
 const f=fixture(t),buffer=new MessageBuffer(path.join(f.root,'state/messages.json'));let generated=0;const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,roleFor:()=> '测试人格',decide:async()=>{generated++;return 'RESPOND: 这条没有发送';},send:(m,text,options)=>f.adapter.sendText({kind:m.kind,target:m.conversation_id,text,...options})});t.after(()=>engine.stop());
 engine.receive({platform:'wechat',kind:'private',conversation_id:'123',conversation_name:'测试好友',sender_id:'123',self_id:'99',text:'你好',message_id:'input-1',message_type:'text',timestamp:Date.now()/1000});
 for(let i=0;i<300&&(generated===0||buffer.unread('wechat:private:123',1).length);i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(generated,1);assert.equal(f.submissions,0);assert.equal(buffer.unread('wechat:private:123',1).length,0);assert.equal(buffer.recent('wechat:private:123',100).filter(r=>r.outgoing).length,0);assert.equal(readReplyPreviews(f.root)[0].text,'这条没有发送');
});

test('console mode selector saves atomically and recent previews never count as sent',async t=>{
 const f=fixture(t);const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));config.wechat.replyDelivery={mode:'preview'};fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(config));
 const {createReplyPreview}=await import('../packages/dsh-social-bridge-plugin/reply-delivery.mjs');createReplyPreview(f.root)({kind:'private',target:'123',text:'查看完整正文'.repeat(50),deliveryId:'x'});
 const {createConsole}=await import('./console-server.mjs');const app=createConsole({root:f.root,port:0,fetchImpl:async()=>new Response('{}')});await app.start();t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.server.address().port,info=await(await fetch(base+'/api/info')).json(),headers={'x-console-token':info.token,'Content-Type':'application/json',Origin:base};
 const initial=await(await fetch(base+'/api/config',{headers})).json();const request=(mode,revision=initial.revision,extra={})=>fetch(base+'/api/reply-mode',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({mode,revision})});
 assert.equal((await request('invalid')).status,400);const response=await request('preview');assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.config.wechat.replyDelivery.mode,'preview');assert.equal((await request('send','stale')).status,400);assert.equal((await request('send',saved.revision,{Origin:'https://foreign.example'})).status,403);
 const status=await(await fetch(base+'/api/status',{headers})).json();assert.equal(status.replyDeliveryMode,'preview');assert.equal(status.stats.sent,0);assert.equal(status.stats.generated,1);assert.equal(status.recent[0].generated,true);assert.equal(status.recent[0].text,'查看完整正文'.repeat(50));
});

test('switching back to send never replays a saved preview delivery',async t=>{
 const f=fixture(t),input={kind:'private',target:'123',text:'旧预览',deliveryId:'f'.repeat(64)};await f.adapter.sendText(input);f.config.wechat.replyDelivery.mode='send';f.save();assert.equal((await f.adapter.sendText(input)).delivered,'preview');assert.equal(f.submissions,0);await f.adapter.sendText({...input,text:'新回复',deliveryId:'1'.repeat(64)});assert.equal(f.submissions,0);
});
test('a mode change at the final native boundary is an unsent preview, not an uncertain send',async t=>{
 const f=fixture(t,{mode:'send'}),native=f.hook.native.bind(f.hook);f.hook.native=(route,...args)=>{if(route==='/SendTextMsg'){f.config.wechat.replyDelivery.mode='preview';f.save();}return native(route,...args);};
 const input={kind:'private',target:'123',text:'切换时不发',deliveryId:'2'.repeat(64)};assert.equal((await f.adapter.sendText(input)).delivered,'preview');assert.equal(f.submissions,0);assert.equal(readReplyPreviews(f.root).length,1);assert.equal((await f.adapter.sendText(input)).delivered,'preview');
});
test('preview logs follow the existing account scope without altering account selection',async t=>{
 const f=fixture(t),active=path.join(f.root,'state/weflow/active-account.json');fs.mkdirSync(path.dirname(active),{recursive:true});fs.writeFileSync(active,JSON.stringify({id:'a'.repeat(64)}));await f.adapter.sendText({kind:'private',target:'123',text:'账号A',deliveryId:'3'.repeat(64)});fs.writeFileSync(active,JSON.stringify({id:'b'.repeat(64)}));assert.equal(readReplyPreviews(f.root).length,0);fs.writeFileSync(active,JSON.stringify({id:'a'.repeat(64)}));assert.equal(readReplyPreviews(f.root)[0].text,'账号A');
});

test('an expired unrelated sticker receipt cannot cause an old preview to be sent',async t=>{
 const f=fixture(t),input={kind:'private',target:'123',id:'6'.repeat(64),deliveryId:'7'.repeat(64)};await f.adapter.sendSticker(input);f.config.wechat.replyDelivery.mode='send';f.save();f.hook.stickerPending.set('private:123',{id:'8'.repeat(64),deliveryId:'9'.repeat(64),account:'wxid_fixture',wxid:'wxid_friend',started:Math.floor(Date.now()/1000)-70,baseline:new Set()});assert.equal((await f.adapter.sendSticker(input)).delivered,'preview');assert(!f.calls.includes('/SendStickerMsg'));
});
test('long generated bodies remain local even with legacy normal mode',async t=>{
 const text='较长的助手回复'.repeat(2000),f=fixture(t);assert.equal((await f.adapter.sendText({kind:'private',target:'123',text,deliveryId:'a'.repeat(64)})).delivered,'preview');assert.equal(readReplyPreviews(f.root)[0].text,text);const normal=fixture(t,{mode:'send'});assert.equal((await normal.adapter.sendText({kind:'private',target:'123',text})).delivered,'preview');assert.equal(normal.submissions,0);
});
