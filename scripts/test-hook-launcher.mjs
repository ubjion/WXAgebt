import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('legacy health and client pinning entry points immediately refuse without touching a client',()=>{
 for(const file of ['hook-client-health.ps1','pin-hook-client.ps1']){
 const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(import.meta.dirname,file)],{encoding:'utf8',windowsHide:true});assert.notEqual(result.status,0);assert.match(result.stderr,/HOOK_DISABLED/);
 }
});
