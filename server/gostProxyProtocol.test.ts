import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTunnelProxyProtocolOptions, gostProxyProtocolMetadata, gostTunnelProxyProtocolPlan, resolveRuleProxyProtocolOptions } from "./gostProxyProtocol";
import { forwardXUdpProxyProtocolFields } from "./sniProxyProtocol";

test("serializes GOST PROXY Protocol versions as metadata strings", () => {
  assert.deepEqual(gostProxyProtocolMetadata(1), { proxyProtocol: "1" });
  assert.deepEqual(gostProxyProtocolMetadata(2), { proxyProtocol: "2" });
  assert.deepEqual(gostProxyProtocolMetadata("2"), { proxyProtocol: "2" });

  const decoded = JSON.parse(JSON.stringify(gostProxyProtocolMetadata(2)));
  assert.equal(typeof decoded.proxyProtocol, "string");
  assert.equal(decoded.proxyProtocol, "2");
});

test("falls back to PROXY Protocol v1 for unsupported versions", () => {
  for (const version of [undefined, null, 0, 3, "invalid"]) {
    assert.deepEqual(gostProxyProtocolMetadata(version), { proxyProtocol: "1" });
  }
});

test("maps tunnel switches only to the end-to-end entry and exit layers", () => {
  assert.deepEqual(gostTunnelProxyProtocolPlan({
    entryReceive: true,
    entrySend: true,
    exitReceive: true,
    exitSend: true,
    version: 2,
  }), {
    entryListener: { proxyProtocol: "2" },
    entryHandler: { proxyProtocol: "2" },
    exitBridgeReceive: { proxyProtocol: "2" },
    exitBridgeSend: { proxyProtocol: "2" },
  });

  assert.deepEqual(gostTunnelProxyProtocolPlan({
    entryReceive: false,
    entrySend: true,
    exitReceive: true,
    exitSend: false,
    version: 1,
  }), {
    entryListener: undefined,
    entryHandler: { proxyProtocol: "1" },
    exitBridgeReceive: { proxyProtocol: "1" },
    exitBridgeSend: undefined,
  });
});

test("preserves the entry source across the local exit bridge", () => {
  assert.deepEqual(effectiveTunnelProxyProtocolOptions({
    entryReceive: false,
    entrySend: true,
    exitReceive: false,
    exitSend: true,
    version: 2,
  }), {
    entryReceive: false,
    entrySend: true,
    exitReceive: true,
    exitSend: true,
    version: 2,
  });
  assert.deepEqual(gostTunnelProxyProtocolPlan({
    entryReceive: false,
    entrySend: true,
    exitReceive: false,
    exitSend: true,
    version: 1,
  }), {
    entryListener: undefined,
    entryHandler: { proxyProtocol: "1" },
    exitBridgeReceive: { proxyProtocol: "1" },
    exitBridgeSend: { proxyProtocol: "1" },
  });
});

test("uses tunnel PROXY Protocol settings over a stale tunnel-rule snapshot", () => {
  const rule = {
    id: 4,
    tunnelId: 5,
    protocol: "both",
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
  };
  const tunnel = {
    id: 5,
    mode: "tls",
    proxyProtocolReceive: false,
    proxyProtocolSend: true,
    proxyProtocolExitReceive: true,
    proxyProtocolExitSend: true,
    proxyProtocolVersion: 2,
  };

  assert.deepEqual(resolveRuleProxyProtocolOptions(rule, tunnel), {
    proxyProtocolReceive: false,
    proxyProtocolSend: true,
    proxyProtocolExitReceive: true,
    proxyProtocolExitSend: true,
    proxyProtocolVersion: 2,
    proxyProtocolUdp: false,
  });
});

test("keeps direct rule settings and disables PROXY Protocol for unsupported tunnel paths", () => {
  assert.deepEqual(resolveRuleProxyProtocolOptions({
    protocol: "tcp",
    proxyProtocolReceive: true,
    proxyProtocolSend: true,
    proxyProtocolVersion: 2,
  }), {
    proxyProtocolReceive: true,
    proxyProtocolSend: true,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 2,
    proxyProtocolUdp: false,
  });

  assert.deepEqual(resolveRuleProxyProtocolOptions({ protocol: "udp", tunnelId: 8 }, {
    id: 8,
    mode: "tls",
    proxyProtocolSend: true,
    proxyProtocolExitSend: true,
    proxyProtocolVersion: 2,
  }), {
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
    proxyProtocolUdp: false,
  });
});

test("UDP rules get PROXY switches only on ForwardX tunnels with the UDP switch and v2", () => {
  const forwardx = { id: 9, mode: "forwardx", proxyProtocolReceive: true, proxyProtocolSend: true, proxyProtocolExitReceive: true, proxyProtocolExitSend: true, proxyProtocolVersion: 2, proxyProtocolUdp: true };
  for (const protocol of ["udp", "both"]) {
    assert.deepEqual(resolveRuleProxyProtocolOptions({ protocol, tunnelId: 9 }, forwardx), {
      proxyProtocolReceive: true,
      proxyProtocolSend: true,
      proxyProtocolExitReceive: true,
      proxyProtocolExitSend: true,
      proxyProtocolVersion: 2,
      proxyProtocolUdp: true,
    }, protocol);
  }
  assert.equal(resolveRuleProxyProtocolOptions({ protocol: "tcp", tunnelId: 9 }, forwardx).proxyProtocolUdp, false);
  for (const tunnel of [
    { ...forwardx, proxyProtocolUdp: false },
    { ...forwardx, proxyProtocolVersion: 1 },
    { ...forwardx, mode: "tls" },
  ]) {
    const options = resolveRuleProxyProtocolOptions({ protocol: "udp", tunnelId: 9 }, tunnel);
    assert.equal(options.proxyProtocolSend, false, JSON.stringify(tunnel));
    assert.equal(options.proxyProtocolUdp, false);
  }
});

test("UDP PROXY is withheld from ForwardX entries older than 3.10.0", () => {
  const tunnel = { mode: "forwardx", proxyProtocolSend: true, proxyProtocolExitSend: true, proxyProtocolVersion: 2, proxyProtocolUdp: true };
  assert.deepEqual(forwardXUdpProxyProtocolFields({ protocol: "udp" }, tunnel, "3.10.0"), { proxyProtocolUdp: true });
  assert.deepEqual(forwardXUdpProxyProtocolFields({ protocol: "both" }, tunnel, "3.10.0"), { proxyProtocolUdp: true });
  // An old entry rejects any PROXY switch on a UDP-only rule, taking the port down.
  assert.deepEqual(forwardXUdpProxyProtocolFields({ protocol: "udp" }, tunnel, "3.9.0"), {
    proxyProtocolReceive: false, proxyProtocolSend: false, proxyProtocolExitReceive: false, proxyProtocolExitSend: false,
  });
  // TCP+UDP keeps the TCP behaviour; the old entry never sees the UDP field.
  assert.deepEqual(forwardXUdpProxyProtocolFields({ protocol: "both" }, tunnel, "3.9.0"), {});
  assert.deepEqual(forwardXUdpProxyProtocolFields({ protocol: "udp" }, { ...tunnel, proxyProtocolUdp: false }, "3.9.0"), {});
});
