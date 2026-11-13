# 20: 纯 UDP 规则延迟探测改进

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.299

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 纯 UDP 规则的延迟探测支持 IPv6 和多地址域名，按回包内容匹配，失败时给出原因（ICMP 不通不代表 UDP 端口不通）。

- [x] Agent：`metrics.go`（ICMPv6、多地址并发、回包匹配）、`selftest.go`（显式 UDP 走 ping，回报 `resolvedTargetIp`）；`agent/go.mod` 只把 `golang.org/x/net` 移到直接依赖，不改版本和 `go` 声明
- [x] 移植 `icmp_probe_test.go`、`selftest_test.go`、`shared/latencyProbe.test.ts`
