# 11: 隧道与链路小修

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.294、v2.3.298、v2.3.299

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 多出口国旗缺失；V2 隧道使用域名无法连接（Agent 先解析 peer 域名再应用）；隧道规则改目标后配置未及时生效、旧流量误判运行状态；FXP 入口组新增规则失败（统一绑定 Agent 身份）。

- [x] 新增 `addTunnelHostNodeMeta`，在 `tunnels.ts`、`linkAccessView.ts`、`linkTestNodeMeta.ts`、`Rules.tsx`、`Tunnels.tsx` 接入（不加任何数量上限）
- [x] Agent：`wireguard_runtime.go` 套补丁；`fxp_additive_sync.go` 抽出 `withFXPAgentIdentity`
- [x] `rules.crud.ts` 推送加 `urgent:true`；`agentReportRoutes.ts` 去掉按流量把规则标为运行中，并核对 ADR-0006/0008 的确认逻辑不依赖它
- [x] 移植 `linkTestNodeMeta`、`linkAccessView`、`tunnelEndpointRefresh`、`agent/wireguard_*`、`fxp_additive_sync` 测试
