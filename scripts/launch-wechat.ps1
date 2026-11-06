param([string]$Executable = '', [string]$ProjectRoot = '')
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if (-not $Executable) {
    $config = Get-Content -LiteralPath (Join-Path $ProjectRoot 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Executable = $config.runtime.wechatExecutable
}
if (-not $Executable -or $Executable -match '[\r\n\x00"]') { throw 'WECHAT_EXECUTABLE_REQUIRED: Configure the ordinary installed WeChat executable.' }
$exe = if ([IO.Path]::IsPathRooted($Executable)) { [IO.Path]::GetFullPath($Executable) } else { [IO.Path]::GetFullPath((Join-Path $ProjectRoot $Executable)) }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'WECHAT_EXECUTABLE_MISSING: The configured WeChat executable is missing.' }
$directory = Split-Path -Parent $exe
# 未知 DLL 不得自动移动或删除；拒绝加载，保留用户文件供人工核对。
if (Test-Path -LiteralPath (Join-Path $directory 'version.dll')) { throw 'WECHAT_HOOK_DLL_PRESENT: Choose a clean ordinary WeChat installation without an adjacent version.dll.' }
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'WECHAT_SIGNATURE_INVALID: WeChat executable signature check failed.' }
# 普通启动不传 Hook 参数、不写入客户端目录，也不终止已有微信进程。
Start-Process -FilePath $exe -WorkingDirectory $directory -WindowStyle Normal
Write-Output 'Opened ordinary WeChat. Log in to the account matching the selected database.'
