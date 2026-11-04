# 仅生成，不发送（保留原有登录检测）

在“设置 → 微信与 DSH → 连接自己的微信 → 回复模式”选择“仅生成，不发送”或“正常发送”，选择后自动保存。

仅生成模式只拦截微信发送调用。原有登录检测、实时账号比对、数据库验证、自动获取密钥以及微信启动流程保持原样；它不是完全不 Hook 的模式。没有通过原有登录检测时，仍然不能启动或绕过账号验证。

通过登录和权限检查后，文字、表情、文件、主动回复及助手通知会获得本机预览回执，不调用 /SendTextMsg、/SendStickerMsg 或 /SendFileMsg。预览不计为已发送，不写入已发送聊天记录。原生发送入口还会再次检查模式，避免切换模式期间误发。

“概览 → 最近记录”标记“已生成 · 未发送”，点击查看保存的正文。保存的是现有回复格式处理后的正文；原始模型会话仍由 DSH 保存。记录按账号隔离，保存于当前数据目录的 workspace/state/accounts/<账号作用域>/reply-previews.jsonl；尚无账号作用域的旧配置使用 workspace/state/reply-previews.jsonl。切回正常发送不会补发已保存的旧预览。

保存失败会报错，不会退回真实发送。单条预览含元数据最多 128 KiB，日志最多 64 MiB，达到上限后须先备份整理记录。正常发送的文字长度和回执规则保持原样。

验证包括：原有登录/账号不匹配拒绝、正常发送及真实回执替身、仅生成零发送、文字/表情/文件、主动消息与助手进度、持久化失败、模式切换竞态、旧预览去重及账号隔离。全部使用本机替身和模拟数据，不对真实微信抓密钥、注入或发消息。

主要测试：node --test scripts/test-reply-preview.mjs scripts/test-file-transfers.mjs scripts/test-wechat-account-check.mjs scripts/test-assistant-feedback.mjs scripts/test-media-nonblocking.mjs scripts/test-reply-protocol.mjs。
