import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runSessionProbe} from './wechat-session-probe.mjs';
import {readerAccountDirectory} from './reader-account-state.mjs';

const failure=code=>Object.assign(new Error(code),{code});
// 登录依据是系统文件占用证据，不再请求微信进程内的 HTTP/Hook 服务。
const canonical=value=>path.resolve(value).replace(/^\\\\\?\\/,'').replaceAll('\\','/').toLowerCase();
export function localAccountProblem(value,directory,now=Date.now()){
  if(!value||value.version!==1||value.backend!=='windows-file-owners'||value.complete!==true||!Number.isFinite(value.at)||Math.abs(now-value.at)>10000||!Array.isArray(value.processes)||!Array.isArray(value.accounts))return 'WECHAT_ACCOUNT_PROBE_FAILED';
  if(!value.processes.length)return 'WECHAT_NOT_RUNNING';
  if(value.processes.length!==1)return 'WECHAT_MULTIPLE_PROCESSES';
  const process=value.processes[0];
  if(!Number.isSafeInteger(process.pid)||process.pid<=0||typeof process.startTime!=='string'||!/^\d+$/.test(process.startTime)||process.trusted!==true)return 'WECHAT_PROCESS_IDENTITY_UNCLEAR';
  if(process.hookProxy===true)return 'WECHAT_HOOK_PRESENT';
  if(!value.accounts.length)return 'WECHAT_LOGIN_REQUIRED';
  if(value.accounts.some(a=>!a||typeof a.directory!=='string'||a.pid!==process.pid||a.startTime!==process.startTime))return 'WECHAT_PROCESS_IDENTITY_UNCLEAR';
  const accounts=[...new Set(value.accounts.map(a=>canonical(a.directory)))];
  if(accounts.length!==1)return 'WECHAT_MULTIPLE_ACCOUNT_DATABASES';
  return accounts[0]===canonical(directory)?'':'WECHAT_ACCOUNT_MISMATCH';
}
export async function verifyWeChatAccount({root,config,settings,probe=runSessionProbe,wait=true,requireReady=true,timeoutMs=30000,intervalMs=300,onProgress=()=>{},now=Date.now,sleep=delay}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<0||timeoutMs>60000||!Number.isFinite(intervalMs)||intervalMs<1)throw failure('READER_ACCOUNT_STATE_INVALID');
  const directory=readerAccountDirectory(root,settings);
  if(!directory||!fs.existsSync(path.join(directory,'db_storage')))throw failure('READER_PATH_MISSING');
  const deadline=now()+timeoutMs;let notified=false;
  for(;;){
    let value;try{value=await probe({root,directory,python:config.runtime?.python??'python',timeoutMs:Math.min(10000,Math.max(1000,deadline-now()))});}
    catch(error){throw failure(['WECHAT_ACCOUNT_PROBE_TIMEOUT','WECHAT_PROCESS_IDENTITY_UNCLEAR','WECHAT_HOOK_PRESENT'].includes(error.code)?error.code:'WECHAT_ACCOUNT_PROBE_FAILED');}
    const code=localAccountProblem(value,directory,now());
    if(!code)return {ready:true,pid:value.processes[0].pid,account:path.basename(directory).toLowerCase(),backend:'windows-file-owners'};
    if(!['WECHAT_NOT_RUNNING','WECHAT_LOGIN_REQUIRED'].includes(code))throw failure(code);
    if(!wait){if(!requireReady)return {ready:false,code};throw failure(code);}
    if(now()>=deadline)throw failure(code);
    if(!notified){onProgress('正在通过系统文件占用信息核对微信账号，请登录所选账号并等待数据库打开…');notified=true;}
    await sleep(Math.min(intervalMs,Math.max(1,deadline-now())));
  }
}
