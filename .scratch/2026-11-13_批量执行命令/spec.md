# 管理员批量执行命令

Status: ready-for-human

## 决策（2026-11-13 与用户确认）

1. **不做交互式终端**，只做批量执行一条命令并收集结果。
2. **不要求二次输入密码**；执行前弹确认框说明将以 root 在 N 台节点执行。
3. **历史存原文**：`command_batches.command` 保存命令以便复用；配置审计只记节点、超时和摘要（行数、字节、sha256 前 16 位）。
4. **保留最近 30 天**：写入新批次和读取历史时清理更早的批次及其结果。
5. **不设每批节点上限**。
6. **支持取消**：整批或单台。

## 行为

- 面板 `hosts.runCommand`（仅管理员）为每台节点建一行结果，经 SSE 推 `agent-command { taskId }`；命令不经事件流。
  - Agent 版本 < 3.10.0 → `unsupported`；没有实时通道 → `undelivered`（不排队，重连后也不执行）。
- Agent 收到任务编号后经加密 `/api/sync` 调 `/api/agent/command-pull` 取命令（挂在受安装身份隔离的 Agent API 路由上，只能取本主机、未结束、未过截止时间的任务），以 root `/bin/sh` 在独立进程组执行，环境变量 `FORWARDX_HOST_ID`、`FORWARDX_TASK_ID`；结束后调 `/api/agent/command-result`，失败重试 3 次。
- 每台节点同时只执行一条，最多再排队 4 条；同一任务编号 1 小时内去重。
- 取消：面板推 `agent-command-cancel`，Agent 结束运行中的进程组或移出队列；面板立即记为 `cancelled`，之后到达的结果保留取消状态但写入输出。
- 截止时间 = 超时 + 60 秒（排队与回报余量）；过期仍未结束的结果记为 `timeout`，也不能再被取走。
- 输出保留最后 1MB（按 UTF-8 边界截断）并标注。
- 状态：queued / running / success / failed / timeout / cancelled / undelivered / unsupported。

## 实现

- 表：`command_batches`、`command_batch_results`（不进迁移列表；直接 SQLite 迁移时源库缺表可接受）。
- 面板：`shared/hostCommands.ts`（限额常量，叶子模块，避免与 `routers/hosts` 循环引用时读到未初始化的值）、`server/hostCommands.ts`、`server/agentCommandRoutes.ts`、`agentEvents.pushAgentCommandTask/Cancel`、`hosts.runCommand/commandBatch/commandBatches/cancelCommand`，`managementCounts.commands` 为页签计数。
- Agent：`agent/host_command.go`；与安装后命令共用 `runShellInGroup`（`agent/post_install.go`）。
- 前端：`client/src/components/hosts/HostCommandRunner.tsx`，主机管理「批量命令」页签。

## 验证

- Agent（`-race`）：执行与回报、环境变量、去重、串行与队列上限、取消运行中（子进程不残留）与排队中、超时、面板拒绝时不执行、取命令失败不阻塞队列。
- 面板（`server/hostCommands.test.ts`）：仅管理员、输入校验、版本不足、无实时通道、事件只含任务编号、审计不含原文、真实加密通道取命令、其他主机与退役安装取不到、1MB 截断、单台与整批取消、迟到结果、截止超时、30 天清理、页签计数。
