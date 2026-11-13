//go:build linux

package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// ADR-0009: IP limits must coexist with Docker's iptables layout and native
// nftables tables. They may only add and remove their own FWX_I* chains and
// fwx ipsets; Docker's policy, chains, admin rules and other tables stay
// byte-for-byte unchanged. Explicit opt-in, run inside a new network namespace.
func TestIPAccessLimitsCoexistWithDockerNetworkNamespace(t *testing.T) {
	if os.Getenv("FORWARDX_TEST_PORT_LIMITS") != "1" {
		t.Skip("requires isolated Linux firewall test")
	}
	if os.Geteuid() != 0 {
		t.Fatal("root is required")
	}
	if os.Getenv("FORWARDX_IP_LIMIT_DOCKER_NETNS_CHILD") != "1" {
		cmd := exec.Command("unshare", "--net", os.Args[0], "-test.run=^TestIPAccessLimitsCoexistWithDockerNetworkNamespace$", "-test.v", "-test.timeout=45s")
		cmd.Env = append(os.Environ(), "FORWARDX_IP_LIMIT_DOCKER_NETNS_CHILD=1")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated Docker coexistence test: %v\n%s", err, out)
		}
		t.Log(string(out))
		return
	}
	ours, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	host, err := os.Readlink("/proc/1/ns/net")
	if err != nil || ours == host {
		t.Fatal("refusing to modify host network namespace")
	}
	run := func(binary string, args ...string) string {
		t.Helper()
		out, err := exec.Command(binary, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v %s", binary, args, err, out)
		}
		return string(out)
	}
	// Docker's iptables layout, an administrator rule and Docker's native nftables table.
	run("iptables", "-P", "FORWARD", "DROP")
	for _, chain := range []string{"DOCKER", "DOCKER-USER", "DOCKER-ISOLATION-STAGE-1"} {
		run("iptables", "-N", chain)
	}
	run("iptables", "-A", "FORWARD", "-j", "DOCKER-USER")
	run("iptables", "-A", "FORWARD", "-j", "DOCKER-ISOLATION-STAGE-1")
	run("iptables", "-A", "DOCKER-USER", "-s", "203.0.113.9", "-j", "DROP", "-m", "comment", "--comment", "admin-deny")
	run("iptables", "-A", "DOCKER-USER", "-j", "RETURN")
	run("iptables", "-t", "nat", "-N", "DOCKER")
	run("iptables", "-t", "nat", "-A", "PREROUTING", "-m", "addrtype", "--dst-type", "LOCAL", "-j", "DOCKER")
	run("iptables", "-t", "mangle", "-A", "PREROUTING", "-s", "198.51.100.7", "-j", "MARK", "--set-mark", "7", "-m", "comment", "--comment", "admin-mark")
	run("nft", "add", "table", "ip", "docker-bridges")
	run("nft", "add", "chain", "ip", "docker-bridges", "filter-FORWARD", "{ type filter hook forward priority filter; policy drop; }")

	foreign := func() string {
		t.Helper()
		var kept []string
		for _, line := range strings.Split(run("iptables-save"), "\n") {
			// Comments, managed chains and packet counters are not part of the foreign layout.
			if strings.HasPrefix(line, "#") || strings.Contains(line, "FWX_") {
				continue
			}
			if strings.HasPrefix(line, ":") {
				if i := strings.Index(line, " ["); i > 0 {
					line = line[:i]
				}
			}
			kept = append(kept, line)
		}
		return strings.Join(kept, "\n") + "\n" + run("nft", "list", "table", "ip", "docker-bridges")
	}
	before := foreign()

	policies := []ipLimitPolicy{{Spec: ipAccessLimitSpec{UserID: 1, MaxIPs: 1, TCPPorts: []int{18080}, UDPPorts: []int{18080}}}}
	if err := syncIPLimitFirewall(policies, false); err != nil {
		t.Fatal(err)
	}
	if err := syncIPLimitFirewall(policies, true); err != nil {
		t.Fatal("applied rules do not verify:", err)
	}
	if !strings.Contains(run("iptables-save", "-t", "mangle"), "FWX_I") {
		t.Fatal("IP-limit chains were not installed")
	}
	if after := foreign(); after != before {
		t.Fatalf("Docker/admin firewall changed while applying IP limits:\n--- before\n%s\n--- after\n%s", before, after)
	}
	// A full quota and a re-apply converge in place without touching foreign rules.
	policies[0].Full, policies[0].IPs = true, []string{"192.0.2.2"}
	for i := 0; i < 2; i++ {
		if err := syncIPLimitFirewall(policies, false); err != nil {
			t.Fatal(err)
		}
	}
	if after := foreign(); after != before {
		t.Fatalf("Docker/admin firewall changed while updating IP limits:\n--- before\n%s\n--- after\n%s", before, after)
	}
	// Removing every policy removes only the managed objects.
	if err := syncIPLimitFirewall(nil, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(run("iptables-save"), "FWX_I") {
		t.Fatal("managed IP-limit chains left behind")
	}
	if sets, _ := exec.Command("ipset", "list", "-n").CombinedOutput(); strings.Contains(string(sets), "FWX_I") {
		t.Fatalf("managed ipsets left behind: %s", sets)
	}
	if after := foreign(); after != before {
		t.Fatalf("Docker/admin firewall changed after removing IP limits:\n--- before\n%s\n--- after\n%s", before, after)
	}
}
