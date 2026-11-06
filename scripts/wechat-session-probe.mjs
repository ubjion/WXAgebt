import path from 'node:path';
import {spawn} from 'node:child_process';
const fault=code=>Object.assign(Error(code),{code});
// 路径仅走私有 stdin；不传密钥、不输出子进程原始诊断。
export function runSessionProbe({root,directory,python='python',timeoutMs=10000}){
 return new Promise((resolve,reject)=>{
  const env={...process.env,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1'};for(const name of ['PYTHONHOME','PYTHONPATH','PYTHONUSERBASE'])delete env[name];
  const child=spawn(python,['-B',path.join(root,'scripts/wechat-session-probe.py')],{cwd:root,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});let data='',size=0,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(fault('WECHAT_ACCOUNT_PROBE_TIMEOUT'));},timeoutMs);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>128*1024){child.kill();finish(fault('WECHAT_ACCOUNT_PROBE_FAILED'));return;}data+=chunk.toString('utf8');});child.stderr.on('data',()=>{});
  child.on('error',()=>finish(fault('WECHAT_ACCOUNT_PROBE_FAILED')));child.on('close',code=>{if(done)return;try{const value=JSON.parse(data);if(code!==0||value.ok===false)throw fault(/^WECHAT_[A-Z_]+$/.test(value.code??'')?value.code:'WECHAT_ACCOUNT_PROBE_FAILED');finish(null,value);}catch(error){finish(error.code?error:fault('WECHAT_ACCOUNT_PROBE_FAILED'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({directory}));
 });
}
