import fs from 'node:fs';
import path from 'node:path';
const fault=code=>Object.assign(new Error(code),{code});
// 仅解析普通微信的独立配置；历史 hook.wechatExecutable 不再参与回退。
export function resolvePlainWeChatExecutable(config,root){
 const executable=config?.runtime?.wechatExecutable;
 if(typeof executable!=='string'||!executable.trim()||/[\r\n\0"]/u.test(executable))throw fault('WECHAT_EXECUTABLE_REQUIRED');
 return path.resolve(root,executable);
}
// 不自动清理相邻 DLL；未知文件必须保留，由用户选择干净的已安装微信。
export function validatePlainWeChatExecutable(executable,{exists=fs.existsSync,signature}={}){
 if(!exists(executable))throw fault('WECHAT_EXECUTABLE_MISSING');
 if(exists(path.join(path.dirname(executable),'version.dll')))throw fault('WECHAT_HOOK_DLL_PRESENT');
 const status=signature?.status??signature?.Status,subject=signature?.subject??signature?.SignerCertificate?.Subject;
 if(status!=='Valid'||typeof subject!=='string'||!/Tencent/i.test(subject))throw fault('WECHAT_SIGNATURE_INVALID');
 return executable;
}
// 签名验证和启动均由调用方提供，便于测试时完全隔离真实微信进程。
export async function launchPlainWeChat({config,root,exists=fs.existsSync,signature,start}){
 const executable=resolvePlainWeChatExecutable(config,root);
 if(!exists(executable))throw fault('WECHAT_EXECUTABLE_MISSING');
 if(exists(path.join(path.dirname(executable),'version.dll')))throw fault('WECHAT_HOOK_DLL_PRESENT');
 if(typeof signature!=='function'||typeof start!=='function')throw fault('WECHAT_LAUNCH_DEPENDENCY_REQUIRED');
 validatePlainWeChatExecutable(executable,{exists,signature:await signature(executable)});
 return start(executable,{args:[],cwd:path.dirname(executable)});
}
