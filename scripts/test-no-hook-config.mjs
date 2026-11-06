import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {prepare,validateConfig} from './project-config.mjs';
import {replyDeliveryMode,saveReplyMode} from '../packages/dsh-social-bridge-plugin/reply-delivery.mjs';
test('legacy Hook config migrates with a backup and preserves existing keys without generating a native token',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'no-hook-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));config.runtime.sender='wechat-hook';config.hook={wechatExecutable:'state/hook/Weixin.exe'};config.wechat.replyDelivery={mode:'send'};
 const put=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 put('config/wechatagent.json',config);put('roles/'+config.persona.default+'.md','本机测试人格');put('state/weflow/WeFlow-config.json',{decryptKey:'userdpapi:Zml4dHVyZQ==',myWxid:'wxid_fixture'});
 const key=fs.readFileSync(path.join(root,'state/weflow/WeFlow-config.json'));prepare(root);
 const result=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json')));assert.equal(result.runtime.sender,'database-only');assert.equal(result.wechat.replyDelivery.mode,'preview');assert.equal(result.hook,undefined);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'state/migrations/no-hook-v1/wechatagent.json'))),config);assert.deepEqual(fs.readFileSync(path.join(root,'state/weflow/WeFlow-config.json')),key);assert(!fs.existsSync(path.join(root,'state/hook/native-token.txt')));
 prepare(root);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/migrations/no-hook-v1/wechatagent.json'))).runtime.sender,'wechat-hook');
 const raw=fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8'),revision=crypto.createHash('sha256').update(raw).digest('hex');assert.throws(()=>saveReplyMode(root,'send',revision),/HOOK_DISABLED/);assert.equal(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8'),raw);
});
test('legacy and missing mode values always generate locally and Hook sender fails validation',()=>{
 assert.equal(replyDeliveryMode({wechat:{replyDelivery:{mode:'send'}}}),'preview');assert.equal(replyDeliveryMode({}),'preview');
 const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));config.runtime.sender='wechat-hook';assert.throws(()=>validateConfig(config),/HOOK_DISABLED/);
});
