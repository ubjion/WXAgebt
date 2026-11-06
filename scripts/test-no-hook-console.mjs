import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createConsole} from './console-server.mjs';

async function fixture(t,{accountReady=true}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'no-hook-console-')),calls=[],checks=[],requests=[];
 const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
 config.wechat.replyDelivery={mode:'preview'};config.runtime.wechatExecutable='C:/WeChat/Weixin.exe';
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),typeof value==='string'?value:JSON.stringify(value));};
 write('config/wechatagent.json',config);write('roles/'+config.persona.default+'.md','测试人格');
 write('state/social-dsh-token.txt','fixture-token');write('state/wechat-io-config.json',{reader_token:'fixture-reader'});
 const reader={dbPath:path.join(root,'wxid_fixture'),myWxid:'wxid_fixture',decryptKey:'userdpapi:YQ=='};
 fs.mkdirSync(path.join(reader.dbPath,'db_storage'),{recursive:true});write('state/weflow/WeFlow-config.json',reader);
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));config.ports.onebot=listener.address().port;write('config/wechatagent.json',config);
 const app=createConsole({root,port:0,runner:async(spec)=>{calls.push(spec);return 0;},accountVerifier:async input=>{checks.push(input);if(!accountReady)throw Object.assign(Error('WECHAT_LOGIN_REQUIRED'),{code:'WECHAT_LOGIN_REQUIRED'});return{ready:true,backend:'windows-file-owners'};},readerSetup:async input=>{requests.push(input.request);return{ok:false,code:'READER_KEY_INVALID'};},fetchImpl:async input=>{
  const url=new URL(input);let body={};
  if(url.pathname==='/api/v1/reader/status')body={backend:'weflow-cli-nt'};
  if(url.pathname==='/api/v1/sessions')body={sessions:[]};
  if(url.pathname==='/status')body={ob_connected:true,reader_connected:true,hook_connected:false,hook_account_verified:false,version:'different'};
  if(url.pathname==='/health')body={ok:true,project:'WeChatAgent',projectRoot:root,contextMode:'native-session-v1',behaviorPolicy:'local-config-only-v1',imageInput:'native-attachment-v1'};
  return new Response(JSON.stringify(body));
 }});
 await app.start();t.after(()=>{app.close();listener.close();assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,info=await(await fetch(base+'/api/info')).json(),headers={'x-console-token':info.token,'Content-Type':'application/json',Origin:base};
 const get=async route=>(await fetch(base+route,{headers})).json();
 const post=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 const finish=async id=>{for(let i=0;i<100;i++){const job=await get('/api/job?id='+id);if(job.state!=='running')return job;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture job timeout');};
 return{root,config,reader,calls,checks,requests,get,post,finish};
}
test('console refuses every Hook job before executing any command',async t=>{
 const f=await fixture(t);
 for(const action of ['hook-build','hook-pin','hook-unpin','hook-check','hook-test']){const r=await f.post('/api/jobs',{action});assert.equal(r.status,400);assert.equal(r.body.error,'HOOK_DISABLED');}
 assert.equal(f.calls.length,0);
 const repair=await f.get('/api/process-recovery?purpose=hook-repair');assert.equal(repair.error,'HOOK_DISABLED');
});
test('open WeChat dispatches only the ordinary launcher',async t=>{
 const f=await fixture(t),r=await f.post('/api/jobs',{action:'wechat-open'});assert.equal(r.status,202);await f.finish(r.body.id);
 assert(f.calls[0].args.some(value=>value.endsWith('launch-wechat.ps1')));assert(!f.calls[0].args.some(value=>/hook|UpdateHook/i.test(path.basename(value))));
});
test('reader request forces manual or cached key validation despite autoKey true',async t=>{
 const f=await fixture(t),saved=await f.get('/api/reader-config');
 const r=await f.post('/api/jobs',{action:'reader-connect',revision:saved.revision,dbPath:f.reader.dbPath,myWxid:f.reader.myWxid,decryptKey:'',autoKey:true});assert.equal(r.status,202);await f.finish(r.body.id);
 assert.equal(f.requests[0].autoKey,false);assert.equal(f.requests[0].decryptKey,f.reader.decryptKey);assert.equal(f.requests[0].wechatExecutable,f.config.runtime.wechatExecutable);
});
test('status readiness uses the independent account verifier with no Hook readiness requirement',async t=>{
 const f=await fixture(t),status=await f.get('/api/status');assert.equal(status.ready,true);assert.equal(status.replyDeliveryMode,'preview');
 assert.equal(f.checks.length,1);assert.equal(f.checks[0].wait,false);assert.equal(f.checks[0].requireReady,true);
});
test('a live reader cannot bypass a missing login proof',async t=>{
 const f=await fixture(t,{accountReady:false}),status=await f.get('/api/status');assert.equal(status.ready,false);assert.equal(status.services.find(s=>s.id==='bridge').ready,false);
});
test('config API rejects send mode even when direct callers bypass the UI',async t=>{
 const f=await fixture(t),saved=await f.get('/api/config');saved.config.wechat.replyDelivery={mode:'send'};
 const r=await f.post('/api/config',saved);assert.equal(r.status,400);assert.equal(r.body.error,'REPLY_DELIVERY_DISABLED');
});
