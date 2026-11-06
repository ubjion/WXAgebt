import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {HookOneBot} from './hook-onebot.mjs';
function fixture(t,verify){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'local-startup-'));
 const put=(name,value)=>{const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 put('config/wechatagent.json',{runtime:{sender:'database-only',weflowMode:'nt'},wechat:{whitelist:{private:[],groups:[]}}});
 put('state/wechat-io-config.json',{reader_base_url:'http://127.0.0.1:5031'});
 put('state/weflow/WeFlow-config.json',{dbPath:path.join(directory,'wxid_fixture'),myWxid:'wxid_fixture'});fs.mkdirSync(path.join(directory,'wxid_fixture/db_storage'),{recursive:true});
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 return new HookOneBot({directory,accountVerifier:verify,fetchImpl:async url=>{assert.equal(new URL(url).port,'5031');return new Response(JSON.stringify({backend:'weflow-cli-nt',ownWxid:'wxid_fixture',accountDirectory:'wxid_fixture'}));}});
}
const error=code=>Object.assign(Error(code),{code});
test('startup waits only for local login proof and never contacts a Hook listener',async t=>{
 let calls=0;const a=fixture(t,async()=>{if(++calls<3)throw error('WECHAT_LOGIN_REQUIRED');return{ready:true};});await a.waitForNative({timeoutMs:500,intervalMs:1});assert.equal(calls,3);assert.equal(a.status.account_verified,true);assert.equal(a.status.hook_connected,false);
});
test('missing login proof has a bounded startup wait',async t=>{const a=fixture(t,async()=>{throw error('WECHAT_NOT_RUNNING');});await assert.rejects(a.waitForNative({timeoutMs:5,intervalMs:1}),/WECHAT_NOT_RUNNING/);assert.equal(a.status.account_verified,false);});
test('wrong, ambiguous and failed local proofs never retry or allow generation',async t=>{for(const code of ['WECHAT_ACCOUNT_MISMATCH','WECHAT_MULTIPLE_ACCOUNT_DATABASES','WECHAT_PROCESS_IDENTITY_UNCLEAR','WECHAT_ACCOUNT_PROBE_TIMEOUT']){let calls=0;const a=fixture(t,async()=>{calls++;throw error(code);});await assert.rejects(a.waitForNative({timeoutMs:100,intervalMs:1}),new RegExp(code));assert.equal(calls,1);assert.equal(a.status.account_verified,false);}});
test('every direct native route is disabled even with no preview field',t=>{const a=fixture(t,async()=>({ready:true}));for(const route of ['/WeChatAgent/health','/SendTextMsg','/SendStickerMsg','/SendFileMsg'])assert.throws(()=>a.native(route,{}),/HOOK_DISABLED/);});
