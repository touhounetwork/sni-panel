# 15: IP 限制改为同时在线来源 IP 数

Status: resolved（2026-11-13）

**上游来源：** v2.3.298

**Blocked by:** 01

**依据：** [本轮规格](../spec.md)

**What to build:** IP 限制改为统计同时在线的来源 IP 数，兼容 TCP/UDP 并过滤短时扫描；Agent 用 ipset、iptables mangle 和 conntrack 实现。

- [x] **先核对**：mangle 钩子和 `addrtype LOCAL` 在 nft 后端主机、Docker 主机上的行为（ADR-0009）；SNI 共用入口端口（ADR-0002）按用户聚合时端口由多用户共享，明确计数语义。核对结论写进本单 Comments 后再实现
- [x] Agent：新增 `ip_access_limits.go`；新动作 `ip-access-limit-sync`；心跳上报 `ipAccessLimitsSupported`；`port_access_limits.go` 抽出通用对账
- [x] 面板：新增 `server/ipAccessLimits.ts`；心跳用 `ipAccessLimitAction`，去掉按单 IP 的 connlimit；旧 Agent 保持旧行为
- [x] 安装脚本：安装时尝试装 ipset，卸载时清理 `FWX_I*` 链和 ipset
- [x] 移植 `ip_access_limits*_test.go`、`ipAccessLimits.test.ts`、`portAccessLimits.test.ts`；在本机隔离网络命名空间里实测（能做到的范围）

## Comments

- 2026-11-13 未完成的验证：未在本机隔离网络命名空间实测 ipset/mangle，也未在 nft 后端或 Docker 主机上核对与 ADR-0009 的共存；只通过了单元测试。
- 2026-11-13 补充：SNI 规则不纳入按用户的 IP 名额（入口端口多用户共用，ADR-0002），已加单元测试与文档说明。新增 `agent/ip_access_limits_docker_linux_test.go`，在隔离网络命名空间里模拟 Docker 的 iptables 布局（FORWARD DROP、DOCKER-USER、管理员规则）和原生 nftables 表，断言 IP 限制只增删自己的 FWX_I* 链与 ipset，其余规则逐字不变。这些测试需要 root，本会话无法 sudo，尚未实际运行；运行方式见 `.dev/root-netns-tests.sh`（需先安装 ipset 与 conntrack）。
- 2026-11-13 用户以 root 运行 `.dev/root-netns-tests.sh`：TestPortAccessLimitsNetworkNamespace、TestIPAccessLimitsNetworkNamespace、TestIPAccessLimitsCoexistWithDockerNetworkNamespace 全部通过（隔离网络命名空间，模拟 Docker 默认 DROP、DOCKER-USER、管理员规则与原生 nftables 表，IP 限制只增删自身链与 ipset）。
