# 累计合入上游 v2.3.293–v2.3.300：规格

Status: resolved（本地实施与验证完成，未推送、未发布）

**Decision date:** 2026-11-13

**确认与授权：** 用户要求「合并 poouo 分支」，并确认按版本移植 v2.3.293–v2.3.300（不做 `git merge`）。实施前已由用户提交本轮 3.10.0 改动（`37b0beaa`）。本规格待用户确认后实施；未授权推送、标签、发布或生产变更。

## Problem Statement

本地 sni-panel 3.10.0 已按功能移植到上游 v2.3.292，但不是 git 祖先关系（共同祖先停在 v2.3.10，上游领先 503 个提交、本地领先 678 个）。上游随后发布 v2.3.293–v2.3.300 共 8 个版本，改动 411 个文件，包括数据库网络防护、权限加固、自编译转发运行时、开发者公告、自动换 IP 全链修复、入口组 DDNS 双栈、主机独立 Agent 面板地址、内存优化、主题管理、套餐计费、IP 限制按在线来源计数、链路测速、用户代入、找回密码、邮件提醒和约 1870 条英文文案重写。直接 `git merge` 会翻出整年的历史差异并覆盖本地 SNI 等能力，所以继续按版本移植。

## Solution

以已兼容的 v2.3.292 为比较起点，按功能把 293–300 的网页、服务端、Agent、FXP 有效增量移植到本地 `main`，并入 3.10.0（不另起版本号）。上游版本之间有依赖（例如 295/296 的换 IP、公告、运行时建立在 293/294 之上；299 的实时速率建立在 298 的主机网速之上），工单按依赖排序。长期约定（AGENTS.md）和下面的用户决定优先于「跟随上游」。

## 用户决定（2026-11-13）

1. **合并方式**：按版本移植 293–300，不做 `git merge`。
2. **版本号**：并入 3.10.0。面板、Agent、FXP 仍为 3.10.0，最低 Agent 版本 3.10.0。
3. **转发运行时**：采用上游 `scripts/build-runtime.sh` 和 `scripts/runtime-patches/`，在本仓库发布流程里从源码编译，作为 touhounetwork Release 资产分发。不引入上游 294 的 `fetch-runtime.sh`，也不从 poouo Release 下载二进制或抄用上游的 SHA256。
4. **开发者公告**：保留功能，地址改为本仓库 `announcements/developer.json`，由 `shared/repo.ts` 派生。
5. **英文文案**：上游改过值的键采用上游 v2.3.300 译文；本地独有的键（约 470 个），以及上游没改但本地改过的键（约 19 个）保持不变。
6. **隧道权限**：隧道的新建、修改、删除改为仅管理员可用，网页上普通用户的入口同步隐藏。主机、Agent Token 的写操作同样仅限管理员。
7. **DDNS**：入口组和转发组新增 A+AAAA 双栈；新建或修改时不再提供 CNAME，已有 CNAME 配置继续工作，显示为「CNAME（旧配置）」。
8. **新依赖**：允许新增 `undici`（Telegram 连接），以及主题管理所需的 `yauzl`、`tar-stream`、`postcss`、`postcss-value-parser`、`node-unrar-js`、`fflate` 和类型包 `@types/yauzl`、`@types/tar-stream`。版本按上游 v2.3.300 的声明。只为这些包增量更新 `pnpm-lock.yaml`，不升级或重新解析已有依赖。
9. **IP 限制**：纳入「同时在线来源 IP 数」，单独一单；实施前先核对与 Docker 共存（ADR-0009）、SNI 共用入口端口（ADR-0002）的关系。
10. **术语**：网页上「入站／出站」统一改为「入向／出向」，包括本地独有的文案，英文同步调整。
11. **用户代入**：纳入。在上游禁止范围（auth、users、google、telegram、discord、setup）之外，代入时还要禁止涉及钱和凭据的写操作，包括支付、余额、购买套餐、流量计费、推广提现、MCP 令牌、Agent Token 等。只读操作和规则、隧道的日常操作允许。
12. **邮件品牌**：提醒邮件的主题和正文用系统设置里的站点名称，没填时仍用 ForwardX。

## 长期约定与排除项（AGENTS.md，不随上游改变）

- **原生客户端**：排除 Android/iOS 工程、版本、依赖和打包，包括 `ios/App/App.xcodeproj/project.pbxproj`、`shared/versions.ts` 里的 App 版本。
- **作者赞助入口**：排除。这一轮上游没有相关改动。
- **SNI 入口选择与 DDNS**：遵守 ADR-0006（SNI 组按已确认的入口健康选择）、ADR-0008（主机型主备组按入口健康选择）、ADR-0010（成员退役先接后断）。上游换 IP 后的强制刷新和成员调整后的 DDNS 兜底，都不能绕过入口健康确认。
- **品牌与仓库地址**：一律从 `shared/repo.ts` 派生。上游硬编码的 `poouo/Forwardx`（公告源、公告里的 releaseUrl、运行时兜底下载、文档链接）都要改掉。
- **拓扑上限**：本地已取消入口组、出口组、转发链、转发组、隧道级数、额外出口、备用出站和主机分组的数量上限，移植时不能带回 `MAX_FORWARD_GROUP_MEMBERS`、`max(10)` 等。
- **列表每页条数**：保留本地 3.9.0 的 20–1000 档，不采用上游的 12/24/36/48。
- **工具链**：不改 `agent/go.mod`、`forwardx-fxp/go.mod` 的 `go` 版本。上游 300 只是把 `golang.org/x/net v0.39.0` 从 indirect 移成直接依赖，版本不变，`go.sum` 已有。Docker 构建阶段的 golang 镜像随运行时编译升到 1.24，只用来编译 GOST，不影响 Agent 的 go 版本声明。
- **不移植**：上游的 `CHANGELOG*`、`docs/guide/releases.md`、`docs/reports/*`、README 的品牌改写、版本号。

## Implementation Decisions

- 工单见 `工单/`，共 28 单，编号即建议顺序。每单写明上游来源版本、上游文件、本地分歧点和验收项。
- **数据库**：新增列都同时改 `drizzle/schema.ts` 和 `server/dbSchema.ts`，由启动时的 ensure 自动补齐。涉及的列有：
  - `hosts.agentPanelUrlEnabled`、`hosts.agentPanelUrl`
  - `host_ip_switch_attempts.reason/httpStatus/cooldownUntil/oldIp/addressSnapshot`，加 `(status, createdAt)` 索引，保留本地已有的 `(createdAt, id)` 索引
  - `subscription_plans.trafficMode`
  - `payment_orders.adminDismissedAt`

  主题、公告、链路测速不新增表。新列要核对 `server/migration.ts` 的迁移和备份列清单。
- **Agent↔面板协议**（全部向后兼容，旧 Agent 忽略新字段）：
  - 心跳的 `panelUrl` 改为按主机解析
  - 新动作 `ip-access-limit-sync`，心跳新增 `ipAccessLimitsSupported`
  - presence 响应新增 `refreshMetrics`
  - 心跳新增 `linkSpeedSupported`，响应新增 `linkSpeedTasks`
  - 新增加密端点 `/api/agent/link-speed-claim`、`/link-speed-result`，要加入 `AGENT_TUNNEL_PATHS`
  - 自测结果可带 `resolvedTargetIp`

  本轮新增的 Agent 能力，最低版本统一按 3.10.0 判断。
- **心跳文件**：`server/agentHeartbeatRoute.ts` 本地远大于上游，按 hunk 手工合并，不整文件替换。
- **测试**：上游新增的测试文件随功能移植，按本地结构改写，并登记到 `package.json` 的 `test:*` 脚本，由 `scripts/verify.mjs` 执行。上游断言 poouo 地址、12 档分页、旧上限的用例要改写或删除。

## Testing Decisions

- 每单完成后跑该单相关的测试组，以及 `tsc --noEmit`。
- 涉及 Agent 的单：`go vet` 加 `go test -race`，在能运行的范围内用真实 Agent 二进制做端到端测试（bwrap 隔离，参照 `.dev/e2e-host-command.mjs`）。
- 涉及数据库的单：SQLite、MariaDB（本地 root/root）、PostgreSQL 都要验证；MariaDB 已有的 3 个 ER_CHECKREAD 失败不算回归。
- 涉及 SNI、DDNS、入口健康的单（05、06、11、15、17）：补回归测试，覆盖 SNI 组、主机型主备组、退役中三种场景。
- 网页改动：在开发面板里用浏览器做中英文实测。
- 收尾时跑 `pnpm test:i18n`，以及环境允许范围内的完整 `node scripts/verify.mjs`。

## Out of Scope

- 推送、打标签、发布、生产部署。
- 原生客户端和作者赞助入口。
- 上游的版本号、CHANGELOG、Release 说明和品牌文案。
- 其他依赖的升级，以及 `go.mod` 的 `go` 版本。

## Further Notes

- 四段只读梳理（293–294、295–296、297–298、299–300）的结论已并入各工单。
- 风险最高的是 06（成员调整后的 DDNS 兜底，要按 ADR 重写）、05（换 IP 后强制刷新与入口健康）、15（ipset/mangle 与 Docker 共存）和 03（运行时自检收紧后，旧节点升级会替换 gost，运行中的连接可能短暂中断，发布说明要写清楚）。

## 本轮实施与验收记录（2026-11-13）

**实施方式变更：** 用户中途要求「全部合并再一起跑测试和提交」，改为对 v2.3.293→v2.3.300 做一次三方合并（排除原生客户端、作者赞助、上游版本号/CHANGELOG/Release 说明/README/`fetch-runtime.sh`/`release-agent.yml`），50 个文件冲突逐一处理，最后统一测试、单次本地提交。

**用户在实施中追加的决定：**
- 未绑定主机的 Token 必须由启用中的管理员签发；已注册主机不论所属用户角色都保持连接，但所属账号停用时拒绝（`tokenRepository.loadAgentAuthTokenCandidates`、`/api/agent/register` 只对新注册检查签发人）。

**与上游不同的处理（按长期约定与 ADR）：**
- 运行时：保留上游源码编译与故障切换补丁，删除 `RELEASE_TAG` 与上游二进制 SHA256；发布清单（protocol/assemble/prepare-image-context）加入 `RUNTIME_*.txt`；只构建 linux/amd64。CI 与发布 Go 工具链基线 1.23.12 → 1.24.13（GOST 源码要求），`go.mod` 未改。
- 成员调整后的 DDNS 兜底：不采用上游「选第一个在线成员」，只保留当前启用、未超量成员仍拥有的已发布地址；成员退役批次进行中不清空原解析（ADR-0006/0008/0010）。
- 无模板主备组的提交前复核保持本地 `memberAgentSelectionStillCurrent`（上游改为含入口健康复核的版本，与本地语义冲突，导致无规则组永不发布）。
- 换 IP 确认后先刷新运行配置，组 DDNS 仍由本地入口健康评估；SNI 规则不因本地监听恢复为运行中。
- 主机每页数量保留本地 20–1000 档，删除上游 12/24/36/48 选择器及其测试。
- 用户代入额外禁止付款、余额、套餐购买、兑换、推广提现、MCP 与 Agent Token 的写操作（`shared/userImpersonation.ts`）。
- 依赖：只新增已批准的包；`postcss` 固定为锁文件已有的 8.5.15，锁文件改动只有新增条目，`--frozen-lockfile` 校验通过。npmmirror 不可用，本次从官方 registry 下载，锁文件只记录 integrity。
- 拓扑上限未恢复；顺带去掉了规则导入中遗漏的备用出站 10 个上限。

**合并后发现并修复的自动合并问题：** `forwardTestRepository` 最新记录查询只取了 `batchId`；`v3_session_test` 丢失 `AgeLastWrite`；`requestBodyParser` 流式限制仍写死 10MB（主题上传 413）；多处重复导入；入口组域名的本地提前返回阻止了 IPv6 追加。

**测试适配（与本地规则一致）：** 分页测试工具补充新页面钩子桩；PostgreSQL 建表测试接受 `ADD COLUMN IF NOT EXISTS`；MySQL 模拟连接补 `query`；上游成员回归测试改为在成员修改锁内调用，并按 ADR-0008/0010 调整两处断言；换 IP 观察测试主机启用记录集 DDNS；Telegram 生命周期测试等待懒加载连接池；本地 SNI 换 IP 场景改用 Agent 实际上报确认流程。

**验证：** 见本轮回复中的测试结果（`tsc`、全部 `test:*` 组、`test:server`、Agent/FXP `go test -race`、真实 Agent 批量命令端到端）。
