package main

import (
	"encoding/json"
	"testing"
)

func sniProxySpec(routes ...fxpSNIRoute) fxpSpec {
	return fxpSpec{Role: "sni-splitter", ListenPort: 24000, Protocol: "tcp", SNIRouteVersion: 5, SNIRoutes: routes}
}

func TestFXPSNIRouteProxyFieldsSurviveAgentReserialization(t *testing.T) {
	// The Agent decodes the panel action, normalizes it and writes the
	// runtime config again; unknown fields would be dropped silently.
	panelJSON := []byte(`{"role":"sni-splitter","listenPort":24000,"protocol":"tcp","sniRouteVersion":5,"sniRoutes":[` +
		`{"sni":"api.example.com","ruleId":1,"targetIp":"127.0.0.1","targetPort":8443,"proxyProtocolReceive":true,"proxyProtocolSend":true,"proxyProtocolVersion":2},` +
		`{"sni":"*","ruleId":2,"targetIp":"127.0.0.1","targetPort":8080,"proxyProtocolReceive":true}]}`)
	var spec fxpSpec
	if err := json.Unmarshal(panelJSON, &spec); err != nil {
		t.Fatal(err)
	}
	spec = normalizeFXPSpec(spec)
	if err := validateFXPSNIRouteTable(spec); err != nil {
		t.Fatalf("route table with PROXY fields and default route rejected: %v", err)
	}
	written, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	var runtime struct {
		SNIRoutes []map[string]any `json:"sniRoutes"`
	}
	if err := json.Unmarshal(written, &runtime); err != nil {
		t.Fatal(err)
	}
	bySNI := map[string]map[string]any{}
	for _, route := range runtime.SNIRoutes {
		bySNI[route["sni"].(string)] = route
	}
	api := bySNI["api.example.com"]
	if api["proxyProtocolReceive"] != true || api["proxyProtocolSend"] != true || api["proxyProtocolVersion"] != float64(2) {
		t.Fatalf("api route lost PROXY fields: %v", api)
	}
	fallback := bySNI["*"]
	if fallback == nil || fallback["proxyProtocolReceive"] != true || fallback["proxyProtocolSend"] != nil || fallback["proxyProtocolVersion"] != nil {
		t.Fatalf("default route fields = %v, want receive only", fallback)
	}
}

func TestFXPSNIRouteProxyFieldsChangeRouteTableNotProcessSignature(t *testing.T) {
	base := sniProxySpec(fxpSNIRoute{SNI: "api.example.com", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443})
	variants := map[string]fxpSpec{
		"receive": sniProxySpec(fxpSNIRoute{SNI: "api.example.com", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443, ProxyProtocolReceive: true}),
		"send v1": sniProxySpec(fxpSNIRoute{SNI: "api.example.com", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443, ProxyProtocolSend: true, ProxyProtocolVersion: 1}),
		"send v2": sniProxySpec(fxpSNIRoute{SNI: "api.example.com", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443, ProxyProtocolSend: true, ProxyProtocolVersion: 2}),
	}
	seen := map[string]string{fxpSNIRouteTableSignature(base): "base"}
	for name, spec := range variants {
		if fxpServerSignature(spec) != fxpServerSignature(base) {
			t.Fatalf("%s changed the process signature; the splitter would restart instead of hot swapping", name)
		}
		if fxpSNIRouteTableMatches(base, spec) {
			t.Fatalf("%s did not change the route table signature; no hot update would be sent", name)
		}
		signature := fxpSNIRouteTableSignature(spec)
		if previous, ok := seen[signature]; ok {
			t.Fatalf("%s has the same route table signature as %s", name, previous)
		}
		seen[signature] = name
	}
	// A version without send is meaningless and must not read as drift.
	unused := sniProxySpec(fxpSNIRoute{SNI: "api.example.com", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443, ProxyProtocolVersion: 2})
	if !fxpSNIRouteTableMatches(base, unused) {
		t.Fatal("an unused PROXY version changed the route table signature")
	}
}

func TestValidateFXPSNIRouteTableRejectsMixedReceiveAndWildcards(t *testing.T) {
	mixed := normalizeFXPSpec(sniProxySpec(
		fxpSNIRoute{SNI: "a.example.com", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443, ProxyProtocolReceive: true},
		fxpSNIRoute{SNI: "b.example.com", RuleID: 2, TargetIP: "127.0.0.1", TargetPort: 8444},
	))
	if err := validateFXPSNIRouteTable(mixed); err == nil {
		t.Fatal("route table mixing receive switches was accepted")
	}
	for _, sni := range []string{"*.example.com", "a*.example.com"} {
		spec := normalizeFXPSpec(sniProxySpec(fxpSNIRoute{SNI: sni, RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443}))
		if err := validateFXPSNIRouteTable(spec); err == nil {
			t.Fatalf("wildcard %q accepted; only the bare default route is allowed", sni)
		}
	}
}

func TestLocalRuntimeStateReportsSNIRouteProxyFields(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	spec := normalizeFXPSpec(fxpSpec{
		Role: "sni-splitter", TunnelID: 12, RuleID: 101, ListenPort: 24000, Protocol: "tcp", SNIRouteVersion: 3,
		SNIRoutes: []fxpSNIRoute{
			{SNI: "api.example.com", RuleID: 101, TargetIP: "203.0.113.10", TargetPort: 443, ProxyProtocolReceive: true, ProxyProtocolSend: true, ProxyProtocolVersion: 2},
			{SNI: "*", RuleID: 202, TargetIP: "203.0.113.11", TargetPort: 8443, ProxyProtocolReceive: true},
		},
	})
	withTestFXPServers(t, map[string]*fxpProcess{fxpServerID(spec): {spec: spec}})
	withTestRuntimeListenReadiness(t, spec.ListenPort)
	seen := map[int]localRuntimeRuleState{}
	for _, rule := range readLocalRuntimeStatePayload().Rules {
		if rule.Port == spec.ListenPort {
			seen[rule.RuleID] = rule
		}
	}
	if rule := seen[101]; !rule.ProxyProtocolReceive || !rule.ProxyProtocolSend || rule.ProxyProtocolVersion != 2 {
		t.Fatalf("route 101 reported %+v", rule)
	}
	if rule := seen[202]; rule.SNI != "*" || !rule.ProxyProtocolReceive || rule.ProxyProtocolSend || rule.ProxyProtocolVersion != 0 {
		t.Fatalf("default route reported %+v", rule)
	}
}
