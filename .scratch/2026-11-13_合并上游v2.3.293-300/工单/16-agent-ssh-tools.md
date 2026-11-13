# 16: Agent SSH 菜单：查看转发环境与单独安装组件

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.298

**Blocked by:** 03

**依据：** [本轮规格](../spec.md)

**What to build:** `fwxm agent tools` 可以查看转发环境，并单独安装 Realm 等组件。

- [x] `scripts/forwardx-manage.sh`、`install-agent.sh`、`agent-proxy.sh`、`agentInstallScripts.ts`（`install_forward_tool_package`、`do_install_tool`）
- [x] gost 走 03 的自编译运行时下载路径和品牌名
- [x] 移植 `agentToolsManagement.test.ts`；`bash -n` 检查生成的脚本
