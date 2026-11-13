import assert from "node:assert/strict";
import test from "node:test";
import { normalizeForwardGroupMembers } from "./services/forwardGroupService";

function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    memberType: "host" as const,
    hostId: index + 1,
    tunnelId: null,
    isEnabled: true,
  }));
}

test("forward chains, entry/exit and failover groups have a minimum but no member cap", () => {
  for (const groupMode of ["chain", "entry", "exit", "failover"] as const) {
    const minimum = groupMode === "chain" ? 2 : 1;
    assert.doesNotThrow(() => normalizeForwardGroupMembers(groupMode, "host", members(minimum)));
    assert.equal(normalizeForwardGroupMembers(groupMode, "host", members(200)).length, 200);
    if (groupMode !== "failover") {
      assert.throws(() => normalizeForwardGroupMembers(groupMode, "host", members(minimum - 1)), /至少需要配置/);
    }
  }
  // A chain behind an entry group needs one host of its own.
  assert.doesNotThrow(() => normalizeForwardGroupMembers("chain", "host", members(1), { externalEntry: true }));
  assert.doesNotThrow(() => normalizeForwardGroupMembers("port", "host", members(200), { externalEntry: true }));
});

test("failover targets are not capped", async () => {
  const { normalizeFailoverInput } = await import("./routers/rules.crud");
  const failoverTargets = Array.from({ length: 30 }, (_, index) => ({ targetIp: `192.0.2.${index + 1}`, targetPort: 443 }));
  const result = normalizeFailoverInput({ failoverEnabled: true, failoverTargets }, "tcp") as any;
  assert.equal(JSON.parse(result.failoverTargets).length, 30);
});
