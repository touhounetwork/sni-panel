package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"
)

func resetSourceSamplesForTest() {
	sourceAnalyticsEnabled.Store(false)
	sourceSamples.Lock()
	sourceSamples.byBatch = map[trafficBatchKey]map[sourceSampleKey]sourceSampleValue{}
	sourceSamples.active = map[*sourceConnection]struct{}{}
	sourceSamples.Unlock()
}

// exchangeWithProxySource sends a PROXY v1 header so the splitter sees a
// routable client address; loopback sources are deliberately ignored.
func exchangeWithProxySource(t *testing.T, port int, sourceIP string, hello, payload, response []byte) {
	t.Helper()
	header := []byte("PROXY TCP4 " + sourceIP + " 198.51.100.9 4242 443\r\n")
	exchangeThroughSniSplitter(t, port, append(header, hello...), payload, response)
}

func TestSniSplitterAttributesSourceIPsToTheRoutedRule(t *testing.T) {
	resetTrafficBatchesForTest()
	resetSourceSamplesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	t.Cleanup(resetSourceSamplesForTest)
	setSourceAnalyticsEnabled(true)

	apiHello, webHello := clientHelloWithECHBytes(t, "api.example.com"), clientHelloWithECHBytes(t, "web.example.com")
	apiPayload, webPayload := []byte("api request"), []byte("web request payload")
	apiResponse, webResponse := []byte("api reply"), []byte("web reply bytes")
	apiPort, _, stopAPI := startReplyingTCPBackend(t, len(apiHello)+len(apiPayload), apiResponse)
	defer stopAPI()
	webPort, _, stopWeb := startReplyingTCPBackend(t, len(webHello)+len(webPayload), webResponse)
	defer stopWeb()
	imgHello := clientHelloWithECHBytes(t, "img.example.com")
	imgPort, _, stopImg := startReplyingTCPBackend(t, len(imgHello)+len(webPayload), webResponse)
	defer stopImg()

	cfg := normalizeConfig(config{
		Role: "sni-splitter", ListenPort: freeTCPPort(t), Protocol: "tcp",
		PanelURL: "http://127.0.0.1:1", Token: "source-test-token", RuleID: 900, SNIRouteVersion: 1,
		SNIRoutes: []sniRoute{
			{SNI: "api.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: apiPort, ProxyProtocolReceive: true},
			{SNI: "web.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: webPort, ProxyProtocolReceive: true},
			{SNI: "img.example.com", RuleID: 303, TargetIP: "127.0.0.1", TargetPort: imgPort, ProxyProtocolReceive: true},
		},
	})
	splitterPort, stopSplitter := startTestSniSplitterWithConfig(t, cfg)
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(stopSplitter) }
	defer stop()

	// Two domains share one port: each connection must land on its own rule.
	exchangeWithProxySource(t, splitterPort, "203.0.113.7", apiHello, apiPayload, apiResponse)
	exchangeWithProxySource(t, splitterPort, "203.0.113.8", webHello, webPayload, webResponse)
	exchangeWithProxySource(t, splitterPort, "203.0.113.7", imgHello, webPayload, webResponse)

	cfg.ListenPort = splitterPort
	key, ok := trafficBatchKeyForConfig(cfg)
	if !ok {
		t.Fatal("test config has no report destination")
	}
	deadline := time.Now().Add(2 * time.Second)
	var pending pendingTrafficBatch
	for {
		trafficBatchFlushMu.Lock()
		pending = trafficBatchPendingSnapshot()[key]
		trafficBatchFlushMu.Unlock()
		if len(pending.sources) == 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	if len(pending.sources) != 3 {
		t.Fatalf("source samples = %+v, want three rule/IP pairs", pending.sources)
	}
	want := map[[2]any][3]uint64{
		{101, "203.0.113.7"}: {uint64(len(apiHello) + len(apiPayload)), uint64(len(apiResponse))},
		{202, "203.0.113.8"}: {uint64(len(webHello) + len(webPayload)), uint64(len(webResponse))},
		{303, "203.0.113.7"}: {uint64(len(imgHello) + len(webPayload)), uint64(len(webResponse))},
	}
	for _, row := range pending.sources {
		got, exists := want[[2]any{row["ruleId"], row["ip"]}]
		if !exists {
			t.Fatalf("unexpected sample %+v", row)
		}
		if row["bytesIn"] != got[0] || row["bytesOut"] != got[1] || row["accounting"] != true {
			t.Fatalf("sample %+v, want in=%d out=%d", row, got[0], got[1])
		}
	}
	if pending.sampledAt <= 0 {
		t.Fatal("pending batch has no sample timestamp")
	}
	// A retry of the same report must carry the same samples, not drain again.
	trafficBatchFlushMu.Lock()
	retry := trafficBatchPendingSnapshot()[key]
	trafficBatchFlushMu.Unlock()
	if retry.reportID != pending.reportID || len(retry.sources) != len(pending.sources) {
		t.Fatalf("retried batch changed: %s/%d vs %s/%d", retry.reportID, len(retry.sources), pending.reportID, len(pending.sources))
	}
}

// Tests that read samples directly hold the flush lock so a background batch
// worker started by an earlier test cannot drain them mid-test.
func holdTrafficFlushForTest(t *testing.T) {
	trafficBatchFlushMu.Lock()
	t.Cleanup(trafficBatchFlushMu.Unlock)
}

func TestSourceSamplesAreNotCollectedWhileDisabled(t *testing.T) {
	holdTrafficFlushForTest(t)
	resetTrafficBatchesForTest()
	resetSourceSamplesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	t.Cleanup(resetSourceSamplesForTest)
	cfg := config{PanelURL: "http://127.0.0.1:1", Token: "disabled-token", Role: "sni-splitter", RuleID: 1, ListenPort: 1}
	addr := &net.TCPAddr{IP: net.ParseIP("203.0.113.9"), Port: 1}
	if conn := trackSourceConnection(cfg, 7, addr); conn != nil {
		t.Fatal("collection started while disabled")
	}
	setSourceAnalyticsEnabled(true)
	conn := trackSourceConnection(cfg, 7, addr)
	conn.counter.in.Add(10)
	// Turning collection off discards what was gathered and stops counting.
	setSourceAnalyticsEnabled(false)
	conn.close()
	key, _ := trafficBatchKeyForConfig(cfg)
	if rows := takeSourceSamples(key); len(rows) != 0 {
		t.Fatalf("samples kept after disabling: %+v", rows)
	}
	for _, loopback := range []string{"127.0.0.1", "::1", "0.0.0.0"} {
		setSourceAnalyticsEnabled(true)
		if conn := trackSourceConnection(cfg, 7, &net.TCPAddr{IP: net.ParseIP(loopback)}); conn != nil {
			t.Fatalf("%s must not be recorded as a visitor", loopback)
		}
	}
}

func TestSourceSamplesStayBoundedPerReport(t *testing.T) {
	holdTrafficFlushForTest(t)
	resetSourceSamplesForTest()
	t.Cleanup(resetSourceSamplesForTest)
	setSourceAnalyticsEnabled(true)
	cfg := config{PanelURL: "http://127.0.0.1:1", Token: "bounded-token", Role: "sni-splitter", RuleID: 1, ListenPort: 1}
	for i := 0; i < maxSourceSamplesPerBatch+50; i++ {
		ip := net.IPv4(198, 18, byte(i/256), byte(i%256))
		trackSourceConnection(cfg, 5, &net.TCPAddr{IP: ip}).close()
	}
	key, _ := trafficBatchKeyForConfig(cfg)
	if rows := takeSourceSamples(key); len(rows) != maxSourceSamplesPerBatch {
		t.Fatalf("rows = %d, want the per-report bound %d", len(rows), maxSourceSamplesPerBatch)
	}
}

func sealedPanelReply(t *testing.T, token string, ts int64, reply any) []byte {
	t.Helper()
	env, err := encryptEnvelopeAt(reply, token, ts)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(env)
	return body
}

func TestPanelReplyControlsTheCollectionSwitch(t *testing.T) {
	resetSourceSamplesForTest()
	t.Cleanup(resetSourceSamplesForTest)
	sourceAnalyticsPolicyTS.Store(0)
	t.Cleanup(func() { sourceAnalyticsPolicyTS.Store(0) })
	const token = "policy-token"
	now := time.Now().UnixMilli()
	applySourceAnalyticsPolicy(sealedPanelReply(t, token, now, map[string]any{"success": true, "sourceAnalyticsEnabled": true}), token)
	if !sourceAnalyticsEnabled.Load() {
		t.Fatal("panel reply did not enable collection")
	}
	// Forged (other token), unauthenticated, replayed and silent replies are ignored.
	applySourceAnalyticsPolicy(sealedPanelReply(t, "other-token", now+1, map[string]any{"sourceAnalyticsEnabled": false}), token)
	applySourceAnalyticsPolicy([]byte(`{"success":true,"sourceAnalyticsEnabled":false}`), token)
	applySourceAnalyticsPolicy(sealedPanelReply(t, token, now-1, map[string]any{"sourceAnalyticsEnabled": false}), token)
	applySourceAnalyticsPolicy(sealedPanelReply(t, token, now+2, map[string]any{"success": true}), token)
	if !sourceAnalyticsEnabled.Load() {
		t.Fatal("an untrusted, stale or silent reply changed the switch")
	}
	applySourceAnalyticsPolicy(sealedPanelReply(t, token, now+3, map[string]any{"sourceAnalyticsEnabled": false}), token)
	if sourceAnalyticsEnabled.Load() {
		t.Fatal("a newer panel reply did not disable collection")
	}
}

func TestSniStatusPollLeavesTheCollectionSwitchAlone(t *testing.T) {
	resetSourceSamplesForTest()
	t.Cleanup(resetSourceSamplesForTest)
	setSourceAnalyticsEnabled(true)
	client, server := net.Pipe()
	go handleSNIRouteTableControl(server, &sniRouteTableStore{})
	if _, err := client.Write([]byte(`{"operation":"status"}`)); err != nil {
		t.Fatal(err)
	}
	var response sniRouteTableControlResponse
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := json.NewDecoder(client).Decode(&response); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if !sourceAnalyticsEnabled.Load() {
		t.Fatal("an Agent status poll must not reset the panel's switch")
	}
}

func TestTrafficReportCarriesSNIAttributedSources(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("not needed on windows")
	}
	resetTrafficBatchesForTest()
	resetSourceSamplesForTest()
	sourceAnalyticsPolicyTS.Store(0)
	t.Cleanup(resetTrafficBatchesForTest)
	t.Cleanup(resetSourceSamplesForTest)
	t.Cleanup(func() { sourceAnalyticsPolicyTS.Store(0) })
	const token = "source-report-token"
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var env envelope
		if err := json.NewDecoder(req.Body).Decode(&env); err != nil {
			w.WriteHeader(500)
			return
		}
		iv, _ := hex.DecodeString(env.IV)
		ct, _ := hex.DecodeString(env.CT)
		key := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
		block, _ := aes.NewCipher(key[:])
		plain := make([]byte, len(ct))
		cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
		var payload map[string]any
		_ = json.NewDecoder(bytes.NewReader(plain)).Decode(&payload)
		select {
		case received <- payload:
		default:
		}
		// The real panel encrypts its reply; this one turns collection off.
		reply, _ := encryptEnvelopeAt(map[string]any{"success": true, "sourceAnalyticsEnabled": false}, token, time.Now().UnixMilli())
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(reply)
	}))
	defer server.Close()
	setSourceAnalyticsEnabled(true)
	cfg := config{PanelURL: server.URL, Token: token, Role: "sni-splitter", RuleID: 1, ListenPort: 8443}
	conn := trackSourceConnection(cfg, 33, &net.TCPAddr{IP: net.ParseIP("2001:db8::7")})
	conn.counter.in.Add(120)
	conn.counter.out.Add(4096)
	conn.close()
	flushTrafficBatches()
	select {
	case payload := <-received:
		if payload["sourceKind"] != "sni-route" {
			t.Fatalf("sourceKind = %v", payload["sourceKind"])
		}
		rows, _ := payload["sourceSamples"].([]any)
		if len(rows) != 1 {
			t.Fatalf("sourceSamples = %+v", payload["sourceSamples"])
		}
		row := rows[0].(map[string]any)
		if row["ip"] != "2001:db8::7" || row["ruleId"] != float64(33) || row["bytesIn"] != float64(120) || row["bytesOut"] != float64(4096) {
			t.Fatalf("sample = %+v", row)
		}
		if at, _ := payload["sourceSampledAt"].(float64); at <= 0 {
			t.Fatalf("sourceSampledAt = %v", payload["sourceSampledAt"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no traffic report sent for source-only batch")
	}
	if sourceAnalyticsEnabled.Load() {
		t.Fatal("the switch in the panel's reply was not applied")
	}
	key, _ := trafficBatchKeyForConfig(cfg)
	trafficBatchMu.Lock()
	_, stillPending := trafficPendingReports[key]
	trafficBatchMu.Unlock()
	if stillPending {
		t.Fatal("accepted report was not acknowledged")
	}
}
