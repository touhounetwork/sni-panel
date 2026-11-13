# 12: 规则卡片 IPv6 入口与批量按入口主机筛选

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.297

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 标准规则卡片展示 IPv6 入口并可选择地址复制；精简卡片入口出口同行、长地址省略并可悬停查看；批量管理可以按入口主机筛选，列表显示主机名和地址。

- [x] `ruleEntryDisplay.ts` 加 IPv6 选项；`Rules.tsx` 的三个入口地址函数手工合并，保留本地 SNI 卡片的分流状态和入口组域名展示
- [x] 新增 `ruleBatchHosts.ts`、`RuleBatchHostSummary.tsx`，接入本地批量对话框；SNI 规则和本地拓扑也要能算出入口主机
- [x] 移植 `ruleEntryDisplay`、`RuleEntryAddresses`、`ruleBatchHosts`、`RuleBatchHostSummary` 测试
