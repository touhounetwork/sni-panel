# SNI 分流 PROXY 头、默认去向、UDP PROXY v2 与按端口域名唯一

Status: ready-for-agent

## 背景

入口机只开一个 TCP 端口，由 SNI 分流器按域名转发到本机多个服务端口；这些服务需要从 PROXY protocol 头取得客户端真实 IP。未匹配连接必须转到真实伪装站，不能「连上即断」（主动探测特征）。

## 决策（2026-11-12 与用户确认）

1. **SNI 收发范围**：只对 `port`（端口转发资源）与 `failover`（主机型转发组）的 SNI 规则开放。这两类分流器同时面对客户端并直连落地；`chain` 与 `tunnel` 的分流器看不到客户端地址，拒绝开启。
2. **发送按规则**：`proxyProtocolSend` + `proxyProtocolVersion`（1 或 2）存于 SNI 规则；成员同步时 SNI 规则从模板规则取值，不被组级 PROXY 设置覆盖。
3. **接收按「入口主机 + 入口端口」**：值存于每条 SNI 规则，保存一条规则时自动同步同主机同端口的全部 SNI 规则（用户选 B）。分流器要求同表路由一致，作为端口级开关生效。接收开启但无头 → 断开（同 entry 角色）。
4. **默认去向**：SNI 填 `*` 的规则；每入口端口最多一条（由按端口唯一保证）。读取失败、无 SNI、查表未命中三条路径都转默认目标并原样回放已读字节；未配置时保持断开。`unmatchedConnections` 照旧累加。`*` 不限资源类型。
5. **热更新**：发送/版本变化进入单条路由签名（只断开该规则既有连接）；接收变化只进入表签名（不断开既有连接）。三字段均由 Agent 回报、面板比对，旧分流器回报不出即不显示运行中。
6. **域名唯一**：按「入口主机 + 入口端口」。不同端口的分流表必然独立（转发链/隧道按资源+入口端口预留出口分流端口；port/failover 直接用入口端口）。批量导入行间查重、主机级写锁、「域名配置不一致」提示均不依赖跨端口唯一，不改逻辑。
7. **UDP**：v2 解析/生成支持 0x12、0x22；仅 forwardx 隧道的 UDP 规则支持，**每个数据报都加头**（用户选 A）。由入口在加密前把头加在载荷前，隧道包格式与出口不变。新增 `tunnels.proxyProtocolUdp`（默认关闭）显式开启，避免存量隧道升级后行为突变。UDP 选 v1 拒绝。iptables/nftables/socat/realm/GOST/nginx 均无法实现，面板禁用并说明原因。Agent 与 FXP 两份 PROXY 实现都加 UDP 地址族（用户选 B）；TCP 调用方遇到 UDP 地址族拒绝。
8. **版本门槛**：`SNI_PROXY_PROTOCOL_MIN_AGENT_VERSION = "3.10.0"`。开启发送/接收、创建 `*`、开启 UDP PROXY 时，涉及的入口 Agent 版本不足即拒绝保存；下发侧对版本不足主机不下发新字段并标记未运行。
9. **升级源**：GitHub 用户名改为 `touhounetwork`（仓库名 `sni-panel` 不变）；加速器、插件商店不改。

## 调查结论：UDP 实现能力

| 实现 | 发送 | 接收 | 依据 |
|---|---|---|---|
| iptables/nftables | 否 | 否 | 内核 DNAT，不改载荷 |
| socat | 否 | 否 | 无此能力 |
| realm | 否 | 否 | `ProxyOpts` 只在 `realm_core/src/tcp` |
| GOST 3.2.6（x v0.8.1） | 不可用 | 否 | handler 以 `header.WriteTo` 单独发一个只含头的数据报；`listener/udp` 无 proxyproto |
| nginx | 否 | — | 仅能发 v1，且本仓库未对 nginx 开放 PROXY |
| FXP forwardx 隧道 | 是 | 是 | 自有代码 |

## 验收

- FXP 端到端：真实分流器监听，v1、v2 分别发送，目标端先收到正确的头再收到完整 ClientHello；接收开启时解析上游头并用于发送与连接限制；默认去向三条路径各测一次（含部分字节回放）。
- 功能四：同一主机两个端口相同域名能保存并各自生效；同一端口重复仍被拒绝。
- 回归以 2026-11-12 基线为准（Go 两模块全过；面板 SNI 相关 19 + 240 + 12 项全过）。
- 后端服务接受的 PROXY 版本由用户真机验证。

## Comments

### 2026-11-12 既有间歇性卡死（与本功能无关）

`server/sniBatchImport.test.ts` 的 `import-concurrency` 场景（「ordinary batches coordinate with single and mixed creates…」）在 `mixed-race` 并发批量保存处间歇卡死、60 秒超时。未改动的 HEAD 副本（原版 harness）同样出现：5/10、2/8、3/5；本分支 6/10。频率相当，判定为既有问题，基线那次恰好通过。

**根因（2026-11-12 已修复，用户要求一并处理）**：SQLite 只有一个连接，事务持有连接锁期间，事务内代码若加入「事务外发起、正排在该事务之后」的共享读取，就会等待自己。两处：`settingsRepository.getAllSettings` 的进行中读取共享，以及 `queryCache` 的进行中加载共享（本例为 `linkAccessView` 读取用户 2 的访问范围）。修复：事务内既不加入也不发布共享读取（事务内读到的可能是未提交数据），`queryCache` 由 `dbRuntime` 注入判断以避免循环引用。修复前 15 次卡 8 次，修复后 20 次 0 次；`server/transactionSharedLoads.test.ts` 在去掉任一修复时失败。

### 2026-11-13 UDP 头的目的地址

入口 UDP 监听绑定通配地址时，`LocalAddr()` 只有 `0.0.0.0`／`::`，真实端到端测试中头的目的地址因此为 `0.0.0.0`。修复：仅在 UDP 发送头时于 bind 前开启 `IP_PKTINFO`（双栈另开 `IPV6_RECVPKTINFO`），按数据报读取实际目的地址（`in_pktinfo.ipi_addr`），取不到时退回监听地址。用标准库 `syscall` 实现，不新增依赖；非 Linux 构建保持原行为。未开启 UDP 发送头的规则收包路径不变。
