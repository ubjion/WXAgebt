// 禁用入口不得导入配置准备模块，避免备份、迁移或写入用户配置。
throw new Error('HOOK_DISABLED: Hook configuration is disabled. Use database-only mode with an existing database key.');
