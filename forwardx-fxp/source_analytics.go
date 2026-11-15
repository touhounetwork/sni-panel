package main

// Source IP analytics for SNI routes. Only the splitter knows which rule a
// shared-port connection was routed to, so it attributes client addresses to
// rules itself. Collection follows the panel switch carried in the replies to
// the splitter's own traffic reports and stays off until the panel enables it.
import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Bounds one pending report; further new sources are dropped until it is sent.
const maxSourceSamplesPerBatch = 2000

var sourceAnalyticsEnabled atomic.Bool

type sourceSampleKey struct {
	ruleID int
	ip     string
}

type sourceSampleValue struct {
	bytesIn, bytesOut, connections uint64
}

// sourceConnection tracks one routed connection so long-lived streams report
// byte deltas on every batch instead of only when they close.
type sourceConnection struct {
	batch              trafficBatchKey
	key                sourceSampleKey
	counter            trafficCounter
	harvestedIn        uint64
	harvestedOut       uint64
	pendingConnections uint64
}

var sourceSamples = struct {
	sync.Mutex
	byBatch map[trafficBatchKey]map[sourceSampleKey]sourceSampleValue
	active  map[*sourceConnection]struct{}
}{
	byBatch: map[trafficBatchKey]map[sourceSampleKey]sourceSampleValue{},
	active:  map[*sourceConnection]struct{}{},
}

func setSourceAnalyticsEnabled(enabled bool) {
	previous := sourceAnalyticsEnabled.Swap(enabled)
	if previous == enabled {
		return
	}
	// Changes follow the panel switch, so they are rare and worth one line.
	log.Printf("sni-splitter source analytics enabled=%v", enabled)
	if !enabled {
		sourceSamples.Lock()
		sourceSamples.byBatch = map[trafficBatchKey]map[sourceSampleKey]sourceSampleValue{}
		sourceSamples.Unlock()
	}
}

// Newest panel response timestamp applied; an older or replayed response can
// never flip the switch back.
var sourceAnalyticsPolicyTS atomic.Int64

// applySourceAnalyticsPolicy reads the panel's collection switch from the
// encrypted reply to a traffic report. The splitter reports straight to the
// panel every few seconds, so a switch change takes effect within one batch.
func applySourceAnalyticsPolicy(body []byte, token string) {
	var env envelope
	if len(body) == 0 || json.Unmarshal(body, &env) != nil || env.V != 1 || env.TS <= 0 {
		return
	}
	iv, errIV := hex.DecodeString(env.IV)
	ct, errCT := hex.DecodeString(env.CT)
	mac, errMAC := hex.DecodeString(env.MAC)
	if errIV != nil || errCT != nil || errMAC != nil || len(iv) != aes.BlockSize {
		return
	}
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	if !hmac.Equal(mac, calcMAC(keyMac[:], iv, ct, env.TS)) {
		return
	}
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return
	}
	plain := make([]byte, len(ct))
	cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
	var reply struct {
		SourceAnalyticsEnabled *bool `json:"sourceAnalyticsEnabled"`
	}
	if json.Unmarshal(plain, &reply) != nil || reply.SourceAnalyticsEnabled == nil {
		return
	}
	for {
		last := sourceAnalyticsPolicyTS.Load()
		if env.TS <= last {
			return
		}
		if sourceAnalyticsPolicyTS.CompareAndSwap(last, env.TS) {
			break
		}
	}
	setSourceAnalyticsEnabled(*reply.SourceAnalyticsEnabled)
}

func sourceSampleIP(addr net.Addr) string {
	var ip net.IP
	switch value := addr.(type) {
	case *net.TCPAddr:
		ip = value.IP
	case *net.UDPAddr:
		ip = value.IP
	default:
		if addr != nil {
			if host, _, err := net.SplitHostPort(addr.String()); err == nil {
				ip = net.ParseIP(host)
			}
		}
	}
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return ip.String()
}

// trackSourceConnection returns nil when collection is off or the address is
// unusable; callers treat nil as "do not count".
func trackSourceConnection(cfg config, ruleID int, client net.Addr) *sourceConnection {
	if !sourceAnalyticsEnabled.Load() || ruleID <= 0 {
		return nil
	}
	ip := sourceSampleIP(client)
	batch, ok := trafficBatchKeyForConfig(cfg)
	if ip == "" || !ok {
		return nil
	}
	conn := &sourceConnection{batch: batch, key: sourceSampleKey{ruleID: ruleID, ip: ip}, pendingConnections: 1}
	sourceSamples.Lock()
	sourceSamples.active[conn] = struct{}{}
	sourceSamples.Unlock()
	return conn
}

func (conn *sourceConnection) close() {
	if conn == nil {
		return
	}
	sourceSamples.Lock()
	harvestSourceConnectionLocked(conn)
	delete(sourceSamples.active, conn)
	sourceSamples.Unlock()
}

func harvestSourceConnectionLocked(conn *sourceConnection) {
	in, out := conn.counter.in.Load(), conn.counter.out.Load()
	delta := sourceSampleValue{bytesIn: in - conn.harvestedIn, bytesOut: out - conn.harvestedOut, connections: conn.pendingConnections}
	if delta.bytesIn == 0 && delta.bytesOut == 0 && delta.connections == 0 {
		return
	}
	if !sourceAnalyticsEnabled.Load() {
		conn.harvestedIn, conn.harvestedOut, conn.pendingConnections = in, out, 0
		return
	}
	byKey := sourceSamples.byBatch[conn.batch]
	if byKey == nil {
		byKey = map[sourceSampleKey]sourceSampleValue{}
		sourceSamples.byBatch[conn.batch] = byKey
	}
	current, exists := byKey[conn.key]
	if !exists && len(byKey) >= maxSourceSamplesPerBatch {
		// Keep the deltas on the connection; they are retried next batch.
		return
	}
	current.bytesIn += delta.bytesIn
	current.bytesOut += delta.bytesOut
	current.connections += delta.connections
	byKey[conn.key] = current
	conn.harvestedIn, conn.harvestedOut, conn.pendingConnections = in, out, 0
}

// takeSourceSamples drains the samples for one report destination. The result
// is stored with the pending traffic batch so retries resend identical data.
func takeSourceSamples(batch trafficBatchKey) []map[string]any {
	sourceSamples.Lock()
	defer sourceSamples.Unlock()
	for conn := range sourceSamples.active {
		if conn.batch == batch {
			harvestSourceConnectionLocked(conn)
		}
	}
	byKey := sourceSamples.byBatch[batch]
	delete(sourceSamples.byBatch, batch)
	if len(byKey) == 0 || !sourceAnalyticsEnabled.Load() {
		return nil
	}
	keys := make([]sourceSampleKey, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].ruleID != keys[j].ruleID {
			return keys[i].ruleID < keys[j].ruleID
		}
		return keys[i].ip < keys[j].ip
	})
	rows := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		value := byKey[key]
		rows = append(rows, map[string]any{
			"ruleId": key.ruleID, "ip": key.ip,
			"bytesIn": value.bytesIn, "bytesOut": value.bytesOut, "accounting": true,
		})
	}
	return rows
}

func sourceSamplesPending(batch trafficBatchKey) bool {
	sourceSamples.Lock()
	defer sourceSamples.Unlock()
	if len(sourceSamples.byBatch[batch]) > 0 {
		return true
	}
	for conn := range sourceSamples.active {
		if conn.batch == batch && (conn.pendingConnections > 0 || conn.counter.in.Load() != conn.harvestedIn || conn.counter.out.Load() != conn.harvestedOut) {
			return true
		}
	}
	return false
}

func sourceSampleBatches() []trafficBatchKey {
	sourceSamples.Lock()
	defer sourceSamples.Unlock()
	seen := map[trafficBatchKey]struct{}{}
	for batch, byKey := range sourceSamples.byBatch {
		if len(byKey) > 0 {
			seen[batch] = struct{}{}
		}
	}
	for conn := range sourceSamples.active {
		seen[conn.batch] = struct{}{}
	}
	out := make([]trafficBatchKey, 0, len(seen))
	for batch := range seen {
		out = append(out, batch)
	}
	return out
}

func sourceSampledAt() int64 {
	return time.Now().Unix()
}
