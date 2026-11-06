import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {readerSetupMessage} from './reader-setup.mjs';

const source=await readFile(new URL('../public/console/console.js',import.meta.url),'utf8');
// 只执行实际页面函数，避免测试启动控制台或连接真实微信。
function loadFunction(name,context={}) {
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const tail=source.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);
  const code=end<0?tail:tail.slice(0,end+1);
  return vm.runInNewContext(`${code}\n${name}`,context);
}
const presentation={header:()=>'',icon:()=>'',escapeHtml:v=>String(v??''),field:(_label,path)=>path,readerDirty:()=>false};
test('reader setup always presents generation only and manual or cached credentials',()=>{
  const state={config:{wechat:{replyDelivery:{mode:'send'}}},reader:{hasKey:false},readerError:''};
  const html=loadFunction('readerConfigurationCard',{...presentation,state})();
  assert.doesNotMatch(html,/value="send"|正常发送|自动获取|获取密钥/);
  assert.match(html,/仅生成，不发送/);
  assert.match(html,/已有.*密钥|有效.*密钥/);
  assert.match(html,/风控风险/);
});
test('connection and tools pages expose ordinary executable and no Hook controls',()=>{
  const context={...presentation,state:{reader:{}},pluginPathField:()=>'',readerConfigurationCard:()=>''};
  const html=loadFunction('connectionsPage',context)()+loadFunction('toolsPage',context)();
  assert.match(html,/runtime.wechatExecutable/);
  assert.doesNotMatch(html,/hook\.|hook-build|hook-pin|hook-unpin|发送组件|发送后端/);
});
test('reader persistence refuses automatic key acquisition even with an old retry argument',async()=>{
  const requests=[],state={reader:{revision:'r1'},readerDraft:{dbPath:'test',decryptKey:'manual'},job:null};
  const context={state,$:()=>({hidden:true}),paintReaderSetup(){},paintJob(){},api:async(_url,body)=>{requests.push(body);return{state:'succeeded'};},pollJob:async()=>{}};
  await loadFunction('persistReader',context)(true);
  assert.equal(requests[0].autoKey,false);
  assert.equal(state.jobBody.autoKey,false);
});
test('reader error messages guide manual key entry and system file login checks',()=>{
  for(const code of ['READER_KEY_INVALID','READER_KEY_REQUIRED','READER_SECRET_UNAVAILABLE','READER_SETUP_TIMEOUT','READER_SETUP_FAILED']) {
    assert.doesNotMatch(readerSetupMessage(code),/重新获取|一键连接|自动连接|获取密钥/);
  }
  for(const code of ['WECHAT_LOGIN_REQUIRED','WECHAT_ACCOUNT_MISMATCH','WECHAT_MULTIPLE_ACCOUNT_DATABASES','WECHAT_ACCOUNT_PROBE_FAILED','WECHAT_ACCOUNT_PROBE_TIMEOUT','WECHAT_HOOK_PRESENT']) {
    assert.notEqual(readerSetupMessage(code),readerSetupMessage('UNKNOWN'));
    assert.doesNotMatch(readerSetupMessage(code),/修复微信连接|匹配微信/);
  }
});
