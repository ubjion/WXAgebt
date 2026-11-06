param([string]$MsBuild = '', [string]$BuildDirectory = '', [string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
# 保留旧命令参数以兼容调用方，但必须在创建目录或启动编译工具之前拒绝。
throw 'HOOK_DISABLED: Hook build is disabled. Use database-only mode with an existing database key.'
