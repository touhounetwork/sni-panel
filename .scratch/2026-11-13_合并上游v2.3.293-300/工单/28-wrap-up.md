# 28: 文档、CHANGELOG 与全量验证

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.299、v2.3.300

**Blocked by:** 01–27

**依据：** [本轮规格](../spec.md)

**What to build:** 收尾：文档、更新说明和整体验证。

- [x] 中英文 CHANGELOG 的 3.10.0 补上本轮各项，写明需要同步升级 Agent，以及运行时替换可能短暂中断连接
- [x] `docs/guide/` 按移植的功能补充（链路测速、主机独立面板地址、主题、找回密码、IP 限制、DDNS 双栈），链接都用本仓库
- [x] 更新 AGENTS.md「累计兼容上游版本」的描述（如有）
- [x] 全量 `node scripts/verify.mjs`（环境允许的范围），以及 Agent `go test -race ./...`；MariaDB 已知 3 个 ER_CHECKREAD 失败单独列出
- [x] 在本规格末尾追加「本轮实施与验收记录」
