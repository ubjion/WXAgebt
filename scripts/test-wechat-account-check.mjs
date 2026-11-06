import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {verifyWeChatAccount} from './wechat-account-check.mjs';
import {createConsole} from './console-server.mjs';
const source=path.resolve(import.meta.dirname,'..'),health={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.1.10.27',startupState:'ready',pid:123,databaseAccounts:['wxid_b']};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-live-account-')),config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json'),'utf8'));config.ports={weflow:0,onebot:0,adapter:0,dshPlugin:0};
 const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 const a={dbPath:path.join(root,'wxid_a'),myWxid:'wxid_a',decryptKey:'userdpapi:YQ=='},b={dbPath:path.join(root,'wxid_b'),myWxid:'wxid_b',decryptKey:'userdpapi:Yg=='};for(const account of [a,b])fs.mkdirSync(path.join(account.dbPath,'db_storage'),{recursive:true});
 write('config/wechatagent.json',config);write('state/weflow/WeFlow-config.json',a);write('state/wechat-io-config.json',{self_wxid:'wxid_a'});write('state/hook/native-token.txt','c'.repeat(64));
 t.after(()=>{assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return{root,config,a,b,write};}
const response=value=>new Response(JSON.stringify(value));

async function consoleFixture(t,{live,setup,stop}={}){
 const f=fixture(t);let setups=0,stops=0,calls=0;
 const app=createConsole({root:f.root,port:0,accountVerifier:input=>verifyWeChatAccount({...input,probe:async()=>{const h=live?live(++calls):health;return{version:1,backend:'windows-file-owners',complete:true,at:Date.now(),processes:[{pid:123,startTime:'456',trusted:true}],accounts:h.databaseAccounts.map(name=>({directory:path.join(f.root,name),pid:123,startTime:'456'}))};}}),readerSetup:async({request})=>{setups++;return setup?setup(request):{ok:true,dbPath:request.dbPath,myWxid:request.myWxid,protectedKey:request.decryptKey||'userdpapi:Yg=='};},fetchImpl:async()=>response(live?live(++calls):health),runner:async()=>{stops++;return stop?stop():0;}});
 const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
 const request=async(route,body)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return r.json();};
 const connect=async()=>request('/api/jobs',{action:'reader-connect',revision:(await request('/api/reader-config')).revision,dbPath:f.b.dbPath,myWxid:f.b.myWxid,decryptKey:'',autoKey:true});
 const wait=async id=>{for(let i=0;i<100;i++){const job=await request('/api/job?id='+id);if(job.finishedAt)return job;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('account fixture timeout');};
 return{...f,request,connect,wait,get setups(){return setups;},get stops(){return stops;}};
}

test('a wrong live account fails before capture or stopping services and leaves the saved account untouched',async t=>{
 const f=await consoleFixture(t,{live:()=>({...health,databaseAccounts:['wxid_a']})}),before=fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'));const job=await f.wait((await f.connect()).id);
 assert.equal(job.state,'failed');assert.equal(job.code,'WECHAT_ACCOUNT_MISMATCH');assert.equal(job.phase,'checking-wechat');assert.equal(f.setups,0);assert.equal(f.stops,0);assert.deepEqual(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json')),before);assert(!fs.existsSync(path.join(f.root,'state/weflow/active-account.json')));
});

test('an incomplete selection cannot silently fall back to the previously saved account',async t=>{
 const f=await consoleFixture(t),revision=(await f.request('/api/reader-config')).revision;
 for(const [dbPath,myWxid]of [[f.b.dbPath,''],['',''],['',f.b.myWxid]]){const result=await f.request('/api/jobs',{action:'reader-connect',revision,dbPath,myWxid,decryptKey:'',autoKey:true});assert(result.error.includes('明确选择'));}
 assert.equal(f.setups,0);assert.equal(f.stops,0);
});

test('a valid cached database still cannot commit when the live account becomes ambiguous after validation',async t=>{
 const f=await consoleFixture(t,{live:call=>({...health,databaseAccounts:call===1?['wxid_b']:['wxid_a','wxid_b']})}),before=fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'));const job=await f.wait((await f.connect()).id);
 assert.equal(job.state,'failed');assert.equal(job.code,'WECHAT_MULTIPLE_ACCOUNT_DATABASES');assert(job.message);assert.equal(f.setups,1);assert.equal(f.stops,0);assert.deepEqual(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json')),before);assert(!job.readerConfigured);
});

test('a login change while old services stop is caught by the final check before saving the new account',async t=>{
 let stopped=false;const f=await consoleFixture(t,{live:()=>({...health,databaseAccounts:[stopped?'wxid_a':'wxid_b']}),stop:()=>{stopped=true;return 0;}}),before=fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'));const job=await f.wait((await f.connect()).id);
 assert.equal(job.state,'failed');assert.equal(job.code,'WECHAT_ACCOUNT_MISMATCH');assert.equal(f.stops,1);assert.deepEqual(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json')),before);assert(!fs.existsSync(path.join(f.root,'state/weflow/active-account.json')));
});

test('a correct live account commits the selected credentials and preserves the DSH restart requirement',async t=>{
 const f=await consoleFixture(t),job=await f.wait((await f.connect()).id);assert.equal(job.state,'succeeded');assert.equal(job.readerConfigured,true);assert.equal(job.accountSwitched,true);assert.equal(job.dshRestartRequired,true);assert.equal(job.phase,'complete');assert.equal(f.stops,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'))).myWxid,'wxid_b');assert(!JSON.stringify(job).includes('userdpapi:'));
});

test('A to B to A uses each live account and restores only that account settings and credential cache',async t=>{
 let account='wxid_b';const f=await consoleFixture(t,{live:()=>({...health,databaseAccounts:[account]})});f.config.wechat.whitelist.private=['123'];f.write('config/wechatagent.json',f.config);
 assert.equal((await f.wait((await f.connect()).id)).state,'succeeded');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json'))).wechat.whitelist.private,[]);
 account='wxid_a';const revision=(await f.request('/api/reader-config')).revision,next=await f.request('/api/jobs',{action:'reader-connect',revision,dbPath:f.a.dbPath,myWxid:f.a.myWxid,decryptKey:'',autoKey:true});assert.equal((await f.wait(next.id)).state,'succeeded');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json'))).wechat.whitelist.private,['123']);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'))).decryptKey,f.a.decryptKey);assert.equal(f.stops,2);
});
