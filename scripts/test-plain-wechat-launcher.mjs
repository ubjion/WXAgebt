import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const policy=()=>import('./plain-wechat-client.mjs');
test('plain WeChat path resolution uses runtime field and ignores legacy Hook paths',async()=>{
 const {resolvePlainWeChatExecutable}=await policy();
 assert.equal(resolvePlainWeChatExecutable({runtime:{wechatExecutable:'client/Weixin.exe'},hook:{wechatExecutable:'state/hook/Weixin.exe'}},root),path.join(root,'client/Weixin.exe'));
 assert.throws(()=>resolvePlainWeChatExecutable({runtime:{},hook:{wechatExecutable:'state/hook/Weixin.exe'}},root),/WECHAT_EXECUTABLE_REQUIRED/);
});
test('plain launch rejects adjacent DLL or invalid signatures before invoking the launcher',async()=>{
 const {launchPlainWeChat}=await policy();let starts=0;
 const config={runtime:{wechatExecutable:path.join(root,'fixture/Weixin.exe')}};
 for(const [dll,signature,code]of [[true,{status:'Valid',subject:'Tencent'},'WECHAT_HOOK_DLL_PRESENT'],[false,{status:'UnknownError',subject:'Tencent'},'WECHAT_SIGNATURE_INVALID'],[false,{status:'Valid',subject:'Other'},'WECHAT_SIGNATURE_INVALID']]){
  await assert.rejects(launchPlainWeChat({config,root,exists:file=>file.endsWith('Weixin.exe')||dll,signature:async()=>signature,start:async()=>starts++}),new RegExp(code));
 }
 assert.equal(starts,0);
});
test('plain launch starts the signed configured executable with no Hook arguments',async()=>{
 const {launchPlainWeChat}=await policy();let launched;
 const executable=path.join(root,'fixture/Weixin.exe');
 await launchPlainWeChat({config:{runtime:{wechatExecutable:executable}},root,exists:file=>file===executable,signature:async()=>({status:'Valid',subject:'CN=Tencent Technology'}),start:async(exe,options)=>{launched={exe,options};}});
 assert.equal(launched.exe,executable);assert.deepEqual(launched.options.args,[]);
});
test('PowerShell launcher verifies signatures and DLLs without changing files or invoking Hook controls',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'plain-wechat-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const exe=path.join(base,'Weixin.exe');fs.writeFileSync(exe,'fake executable, never launched');
 const harness=path.join(base,'test.ps1');fs.writeFileSync(harness,`param($Launcher,$Exe)\n$ErrorActionPreference='Stop'\n$global:starts=0\nfunction Get-AuthenticodeSignature { param($LiteralPath) [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Subject='CN=Tencent Technology'}} }\nfunction Start-Process { param($FilePath,$WorkingDirectory,$WindowStyle) if($FilePath -ne $Exe){throw 'unexpected executable'};$global:starts++ }\n& $Launcher -Executable $Exe\nif($global:starts -ne 1){throw 'did not launch'}\nSet-Content -LiteralPath (Join-Path (Split-Path $Exe) 'version.dll') -Value 'unknown file'\ntry { & $Launcher -Executable $Exe; throw 'DLL accepted' } catch {if($_.Exception.Message -notmatch 'WECHAT_HOOK_DLL_PRESENT'){throw}}\nif($global:starts -ne 1){throw 'launched with DLL'}\nif((Get-Content -Raw -LiteralPath (Join-Path (Split-Path $Exe) 'version.dll')).Trim() -ne 'unknown file'){throw 'DLL changed'}\n`);
 const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',harness,'-Launcher',path.join(root,'scripts/launch-wechat.ps1'),'-Exe',exe],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const legacy=fs.readFileSync(path.join(root,'scripts/launch-hook-wechat.ps1'),'utf8');
 assert.match(legacy,/launch-wechat\.ps1/);assert.doesNotMatch(legacy,/Copy-Item|Set-Acl|Stop-Process|pin-hook|Wait-HookClient|StartPort/);
});
