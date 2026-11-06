"""Read-only Windows process/file ownership evidence. Never inject or send messages."""
import ctypes
from ctypes import wintypes
import json
import os
import pathlib
import subprocess
import sys
import time
import stat

class ProbeError(Exception):pass
class UniqueProcess(ctypes.Structure):
    _fields_=[('pid',wintypes.DWORD),('start',wintypes.FILETIME)]
class ProcessInfo(ctypes.Structure):
    _fields_=[('process',UniqueProcess),('app',wintypes.WCHAR*256),('service',wintypes.WCHAR*64),('kind',ctypes.c_int),('status',wintypes.DWORD),('session',wintypes.DWORD),('restartable',wintypes.BOOL)]
def filetime(value):return str((value.dwHighDateTime<<32)|value.dwLowDateTime)
def file_owners(paths):
    if not paths or len(paths)>128 or any(not pathlib.Path(p).is_file() for p in paths):raise ValueError('file resources required')
    if os.name!='nt':raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    rm=ctypes.WinDLL('rstrtmgr',use_last_error=True)
    rm.RmStartSession.argtypes=[ctypes.POINTER(wintypes.DWORD),wintypes.DWORD,wintypes.LPWSTR];rm.RmStartSession.restype=wintypes.DWORD
    rm.RmRegisterResources.argtypes=[wintypes.DWORD,wintypes.UINT,ctypes.POINTER(wintypes.LPCWSTR),wintypes.UINT,ctypes.c_void_p,wintypes.UINT,ctypes.c_void_p];rm.RmRegisterResources.restype=wintypes.DWORD
    rm.RmGetList.argtypes=[wintypes.DWORD,ctypes.POINTER(wintypes.UINT),ctypes.POINTER(wintypes.UINT),ctypes.POINTER(ProcessInfo),ctypes.POINTER(wintypes.DWORD)];rm.RmGetList.restype=wintypes.DWORD
    rm.RmEndSession.argtypes=[wintypes.DWORD];rm.RmEndSession.restype=wintypes.DWORD
    handle=wintypes.DWORD();key=ctypes.create_unicode_buffer(33)
    if rm.RmStartSession(ctypes.byref(handle),0,key):raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    try:
        resources=(wintypes.LPCWSTR*len(paths))(*paths)
        if rm.RmRegisterResources(handle,len(paths),resources,0,None,0,None):raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
        needed=wintypes.UINT();count=wintypes.UINT();reasons=wintypes.DWORD()
        code=rm.RmGetList(handle,ctypes.byref(needed),ctypes.byref(count),None,ctypes.byref(reasons))
        if code==0 and needed.value==0:return []
        for _ in range(3):
            if code!=234 or not 0<needed.value<=512:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
            count=wintypes.UINT(needed.value);rows=(ProcessInfo*needed.value)()
            code=rm.RmGetList(handle,ctypes.byref(needed),ctypes.byref(count),rows,ctypes.byref(reasons))
            if code==0:return [{'pid':int(row.process.pid),'startTime':filetime(row.process.start)} for row in rows[:count.value]]
        raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    finally:rm.RmEndSession(handle)

def resource_exists(file, directory=False):
    # 拒绝目录联接与文件链接，避免把其他账号的数据库归到所选目录。
    try:
        value=file.lstat()
    except FileNotFoundError:return False
    except OSError:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED') from None
    if stat.S_ISLNK(value.st_mode) or getattr(value,'st_file_attributes',0)&0x400:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    return stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)

def account_candidates(directory):
    selected=pathlib.Path(directory).resolve()
    if not resource_exists(selected/'db_storage',True):raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    result={str(selected)}
    try:
        for child in selected.parent.iterdir():
            if resource_exists(child,True) and resource_exists(child/'db_storage',True):result.add(str(child.resolve()))
            if len(result)>32:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    except OSError:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED') from None
    return sorted(result)

def account_files(directory):
    db=pathlib.Path(directory)/'db_storage'
    candidates=[]
    for folder,name in [('contact','contact.db'),('session','session.db')]:
        base=db/folder
        if resource_exists(base,True):candidates.extend([base/name,base/(name+'-wal')])
    base=db/'message'
    if resource_exists(base,True):
        try:messages=sorted(base.glob('message_*.db'))
        except OSError:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED') from None
        if len(messages)>32:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
        for file in messages:candidates.extend([file,pathlib.Path(str(file)+'-wal')])
    return [str(file) for file in candidates if resource_exists(file)]

def kernel():
    if os.name!='nt':raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    lib=ctypes.WinDLL('kernel32',use_last_error=True)
    lib.CreateToolhelp32Snapshot.argtypes=[wintypes.DWORD,wintypes.DWORD];lib.CreateToolhelp32Snapshot.restype=wintypes.HANDLE
    lib.CloseHandle.argtypes=[wintypes.HANDLE];lib.CloseHandle.restype=wintypes.BOOL
    lib.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];lib.OpenProcess.restype=wintypes.HANDLE
    lib.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)];lib.QueryFullProcessImageNameW.restype=wintypes.BOOL
    lib.GetProcessTimes.argtypes=[wintypes.HANDLE,*([ctypes.POINTER(wintypes.FILETIME)]*4)];lib.GetProcessTimes.restype=wintypes.BOOL
    return lib

def inventory():
    lib=kernel()
    class Entry(ctypes.Structure):
        _fields_=[('size',wintypes.DWORD),('usage',wintypes.DWORD),('pid',wintypes.DWORD),('heap',ctypes.c_size_t),('module',wintypes.DWORD),('threads',wintypes.DWORD),('parent',wintypes.DWORD),('priority',wintypes.LONG),('flags',wintypes.DWORD),('exe',wintypes.WCHAR*260)]
    lib.Process32FirstW.argtypes=[wintypes.HANDLE,ctypes.POINTER(Entry)];lib.Process32FirstW.restype=wintypes.BOOL
    lib.Process32NextW.argtypes=lib.Process32FirstW.argtypes;lib.Process32NextW.restype=wintypes.BOOL
    handle=lib.CreateToolhelp32Snapshot(2,0)
    if handle==ctypes.c_void_p(-1).value:raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
    result={}
    try:
        entry=Entry();entry.size=ctypes.sizeof(entry);found=lib.Process32FirstW(handle,ctypes.byref(entry))
        while found:
            result[int(entry.pid)]={'parent':int(entry.parent),'name':entry.exe};found=lib.Process32NextW(handle,ctypes.byref(entry))
    finally:lib.CloseHandle(handle)
    return result

def main_roots(entries):
    matches={pid for pid,row in entries.items() if row['name'].casefold() in ('weixin.exe','wechat.exe')}
    result=[]
    for pid in matches:
        parent=entries[pid]['parent'];seen={pid};nested=False
        while parent and parent in entries:
            if parent in seen:raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
            if parent in matches:nested=True;break
            seen.add(parent);parent=entries[parent]['parent']
        if not nested:result.append(pid)
    return sorted(result)

def under_root(pid,root,entries):
    seen=set()
    while pid in entries and pid not in seen:
        if pid==root:return True
        seen.add(pid);pid=entries[pid]['parent']
    return False

def process_identity(pid):
    lib=kernel();handle=lib.OpenProcess(0x1000,False,pid)
    if not handle:raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
    try:
        size=wintypes.DWORD(32768);name=ctypes.create_unicode_buffer(size.value);times=[wintypes.FILETIME() for _ in range(4)]
        if not lib.QueryFullProcessImageNameW(handle,0,name,ctypes.byref(size)) or not lib.GetProcessTimes(handle,*[ctypes.byref(v) for v in times]):raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
        return {'pid':pid,'startTime':filetime(times[0]),'executable':name.value}
    finally:lib.CloseHandle(handle)

def trusted_executable(executable):
    command="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$p=([Console]::In.ReadToEnd()|ConvertFrom-Json).path;$s=Get-AuthenticodeSignature -LiteralPath $p;@{trusted=($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Tencent')}|ConvertTo-Json -Compress"
    env={**os.environ};env['PSModulePath']=str(pathlib.Path(env.get('SystemRoot','C:/Windows'))/'System32/WindowsPowerShell/v1.0/Modules')
    exe=pathlib.Path(env.get('SystemRoot','C:/Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result=subprocess.run([str(exe),'-NoProfile','-NonInteractive','-Command',command],input=json.dumps({'path':executable}),capture_output=True,text=True,encoding='utf-8',timeout=5,env=env,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        return result.returncode==0 and json.loads(result.stdout).get('trusted') is True
    except (OSError,ValueError,subprocess.TimeoutExpired):raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR') from None

def probe(directory):
    entries=inventory();roots=main_roots(entries);processes=[process_identity(pid) for pid in roots];accounts=[]
    for row in processes:
        row['trusted']=trusted_executable(row['executable']);row['hookProxy']=(pathlib.Path(row['executable']).parent/'version.dll').is_file()
    # 没有微信、存在多个进程树或旧代理DLL时不继续读取文件占用，不猜测登录状态。
    if len(processes)==1 and processes[0]['trusted'] and not processes[0]['hookProxy']:
        root=processes[0]
        for account in account_candidates(directory):
            files=account_files(account)
            if not files:continue
            for owner in file_owners(files):
                if not under_root(owner['pid'],root['pid'],entries):continue
                current=process_identity(owner['pid'])
                if current['startTime']!=owner['startTime'] or int(current['startTime'])<int(root['startTime']):raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
                if owner['pid']!=root['pid'] and not trusted_executable(current['executable']):raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
                accounts.append({'directory':account,'pid':root['pid'],'startTime':root['startTime']});break
        after=inventory()
        if main_roots(after)!=roots:raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
        if process_identity(root['pid'])['startTime']!=root['startTime']:raise ProbeError('WECHAT_PROCESS_IDENTITY_UNCLEAR')
    return {'version':1,'backend':'windows-file-owners','at':int(time.time()*1000),'complete':True,'processes':processes,'accounts':accounts}

if __name__=='__main__':
    try:
        request=json.loads(sys.stdin.read(16385));directory=request.get('directory')
        if not isinstance(directory,str) or len(directory)>4096 or not pathlib.Path(directory).is_absolute():raise ProbeError('WECHAT_ACCOUNT_PROBE_FAILED')
        print(json.dumps(probe(directory),ensure_ascii=True,separators=(',',':')))
    except Exception as error:
        code=str(error) if isinstance(error,ProbeError) else 'WECHAT_ACCOUNT_PROBE_FAILED';print(json.dumps({'ok':False,'code':code}));sys.exit(1)
