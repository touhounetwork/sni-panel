//go:build !windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExecutePostInstallCommandReportsExitOutputAndEnv(t *testing.T) {
	var live bytes.Buffer
	result := executePostInstallCommand(`echo "mode=$FORWARDX_INSTALL_MODE host=$FORWARDX_HOST_ID panel=$FORWARDX_PANEL_URL"; echo oops >&2; exit 3`, "upgrade", 7, "https://panel.example", &live)
	if result["exitCode"] != 3 || result["timedOut"] != false || result["runMode"] != "upgrade" {
		t.Fatalf("result = %+v", result)
	}
	output := result["output"].(string)
	for _, want := range []string{"mode=upgrade host=7 panel=https://panel.example", "oops"} {
		if !strings.Contains(output, want) || !strings.Contains(live.String(), want) {
			t.Fatalf("output %q / live %q missing %q", output, live.String(), want)
		}
	}
}

func TestExecutePostInstallCommandTimeoutKillsProcessGroup(t *testing.T) {
	old := postInstallHookTimeout
	postInstallHookTimeout = 300 * time.Millisecond
	defer func() { postInstallHookTimeout = old }()
	marker := filepath.Join(t.TempDir(), "child-survived")
	started := time.Now()
	// The background child would outlive a plain kill of the shell.
	result := executePostInstallCommand(`(sleep 2; touch `+marker+`) & sleep 30`, "install", 1, "", &bytes.Buffer{})
	if result["timedOut"] != true {
		t.Fatalf("result = %+v", result)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child of the timed-out command kept running")
	}
}

func TestPostInstallTailKeepsLastMegabyte(t *testing.T) {
	tail := &tailBuffer{limit: 8}
	_, _ = tail.Write([]byte("0123456789abc"))
	got, truncated := tail.snapshot()
	if got != "56789abc" || !truncated {
		t.Fatalf("tail = %q truncated=%v", got, truncated)
	}
	result := executePostInstallCommand(`head -c 1200000 /dev/zero | tr '\0' x; echo END`, "install", 1, "", &bytes.Buffer{})
	output := result["output"].(string)
	if len(output) != postInstallMaxReportBytes || !strings.HasSuffix(output, "END\n") || result["outputTruncated"] != true {
		t.Fatalf("len=%d suffix=%q truncated=%v", len(output), output[len(output)-4:], result["outputTruncated"])
	}
}

func TestRunPostInstallNeverFailsTheInstaller(t *testing.T) {
	var out bytes.Buffer
	// Unreachable panel: lookup fails, the hook is skipped with a warning.
	code := runPostInstall(Config{PanelURL: "http://127.0.0.1:1", Token: "t"}, "install", &out)
	if code != 0 || !strings.Contains(out.String(), "无法从面板获取自定义命令") {
		t.Fatalf("code=%d out=%q", code, out.String())
	}
	out.Reset()
	if code := runPostInstall(Config{}, "bogus", &out); code != 0 {
		t.Fatalf("unknown mode returned %d", code)
	}
}

func TestExecutePostInstallStepsRunsEachStepSeparately(t *testing.T) {
	var live bytes.Buffer
	result := executePostInstallSteps([]installHookStep{
		{Source: "global", Command: `echo from-global; exit 4`},
		// A syntax error in one step must not break the other.
		{Source: "host", Command: `echo from-host`},
	}, "install", 1, "", &live)
	output := result["output"].(string)
	for _, want := range []string{"=== 全局命令 ===", "from-global", "=== 本节点命令 ===", "from-host"} {
		if !strings.Contains(output, want) {
			t.Fatalf("output %q missing %q", output, want)
		}
	}
	if result["exitCode"] != 4 || result["timedOut"] != false {
		t.Fatalf("first failure should be reported: %+v", result)
	}
	result = executePostInstallSteps([]installHookStep{{Source: "global", Command: `if then`}, {Source: "host", Command: `echo still-runs`}}, "install", 1, "", &bytes.Buffer{})
	if !strings.Contains(result["output"].(string), "still-runs") || result["exitCode"] == 0 {
		t.Fatalf("syntax error result = %+v", result)
	}
}

func TestExecutePostInstallStepsShareOneTimeout(t *testing.T) {
	old := postInstallHookTimeout
	postInstallHookTimeout = 400 * time.Millisecond
	defer func() { postInstallHookTimeout = old }()
	result := executePostInstallSteps([]installHookStep{{Source: "global", Command: `sleep 30`}, {Source: "host", Command: `echo should-not-run`}}, "install", 1, "", &bytes.Buffer{})
	if result["timedOut"] != true || strings.Contains(result["output"].(string), "should-not-run") {
		t.Fatalf("result = %+v", result)
	}
}
