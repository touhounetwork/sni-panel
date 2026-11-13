export const IMPERSONATION_PREFIX = "fxi.";
export const IMPERSONATION_TTL_SECONDS = 60 * 60;
export const IMPERSONATION_EXPIRED = "用户代入已结束，请从用户管理重新进入";
export const IMPERSONATION_SECURITY_BLOCKED = "代入模式下无法修改账号安全设置，请返回管理员窗口操作";
export const IMPERSONATION_MONEY_BLOCKED = "代入模式下不能付款、充值、兑换、提现或管理令牌，请让用户本人操作";

// Mutations that move money or create/revoke credentials. Price previews stay available.
const MONEY_OR_CREDENTIAL_NAMESPACES = /^(payment|billing|plans|trafficBilling|affiliates|mcp|agentTokens)\./;
const READ_ONLY_MUTATIONS = new Set(["billing.previewDiscount"]);
export function isImpersonationMoneyOrCredentialWrite(path: string) {
  return MONEY_OR_CREDENTIAL_NAMESPACES.test(path) && !READ_ONLY_MUTATIONS.has(path);
}
