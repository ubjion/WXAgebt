param([switch]$PrepareOnly, [switch]$UpdateHook, [string]$ProjectRoot = '', [string]$Executable = '')
$ErrorActionPreference = 'Stop'
# 保留旧启动命令作为普通微信入口；准备或更新注入组件的选项必须明确拒绝。
if ($PrepareOnly -or $UpdateHook) { throw 'HOOK_DISABLED: Hook preparation and updates are disabled.' }
& (Join-Path $PSScriptRoot 'launch-wechat.ps1') -ProjectRoot $ProjectRoot -Executable $Executable
