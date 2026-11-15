//go:build !windows

package main

import (
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeCommandPanel struct {
	mu       sync.Mutex
	commands map[string]hostCommandPull
	results  map[string]map[string]any
	pulled   []string
	done     chan string
}

func newFakeCommandPanel() *fakeCommandPanel {
	return &fakeCommandPanel{commands: map[string]hostCommandPull{}, results: map[string]map[string]any{}, done: make(chan string, 16)}
}

func (p *fakeCommandPanel) scheduler() *hostCommandScheduler {
	return newHostCommandScheduler(
		func(_ Config, taskID string) (hostCommandPull, error) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.pulled = append(p.pulled, taskID)
			if pull, ok := p.commands[taskID]; ok {
				return pull, nil
			}
			return hostCommandPull{Success: false}, nil
		},
		func(_ Config, result map[string]any) error {
			p.mu.Lock()
			p.results[result["taskId"].(string)] = result
			p.mu.Unlock()
			p.done <- result["taskId"].(string)
			return nil
		},
		&strings.Builder{},
	)
}

func (p *fakeCommandPanel) add(taskID, command string, timeoutSeconds int) {
	p.mu.Lock()
	p.commands[taskID] = hostCommandPull{Success: true, HostID: 9, TaskID: taskID, Command: command, TimeoutSeconds: timeoutSeconds}
	p.mu.Unlock()
}

func (p *fakeCommandPanel) wait(t *testing.T, taskID string) map[string]any {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case id := <-p.done:
			if id == taskID {
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.results[taskID]
			}
		case <-deadline:
			t.Fatalf("no result for %s", taskID)
		}
	}
}

func TestHostCommandRunsReportsAndPassesEnv(t *testing.T) {
	panel := newFakeCommandPanel()
	s := panel.scheduler()
	panel.add("aa01", `echo "host=$FORWARDX_HOST_ID task=$FORWARDX_TASK_ID"; echo err >&2; exit 3`, 30)
	if !s.schedule(Config{}, "aa01") {
		t.Fatal("not scheduled")
	}
	result := panel.wait(t, "aa01")
	if result["exitCode"] != 3 || result["timedOut"] == true || result["cancelled"] == true {
		t.Fatalf("result = %+v", result)
	}
	if out := result["output"].(string); !strings.Contains(out, "host=9 task=aa01") || !strings.Contains(out, "err") {
		t.Fatalf("output = %q", out)
	}
	if s.schedule(Config{}, "aa01") {
		t.Fatal("a duplicate delivery was scheduled again")
	}
}

func TestHostCommandRunsOneAtATimeAndBoundsQueue(t *testing.T) {
	panel := newFakeCommandPanel()
	s := panel.scheduler()
	marker := t.TempDir() + "/overlap"
	// Each command fails if another one is running at the same time.
	cmd := `[ -e ` + marker + ` ] && exit 9; touch ` + marker + `; sleep 0.2; rm -f ` + marker
	ids := []string{"b1", "b2", "b3", "b4", "b5"}
	for _, id := range ids {
		panel.add(id, cmd, 30)
	}
	for _, id := range ids {
		if !s.schedule(Config{}, id) {
			t.Fatalf("%s rejected", id)
		}
	}
	// One running plus four queued: the sixth is rejected.
	panel.add("b6", cmd, 30)
	if s.schedule(Config{}, "b6") {
		t.Fatal("queue limit not enforced")
	}
	for _, id := range ids {
		if code := panel.wait(t, id)["exitCode"]; code != 0 {
			t.Fatalf("%s overlapped another command: exit %v", id, code)
		}
	}
}

func TestHostCommandCancelRunningAndQueued(t *testing.T) {
	panel := newFakeCommandPanel()
	s := panel.scheduler()
	marker := t.TempDir() + "/child"
	panel.add("c1", `(sleep 2; touch `+marker+`) & sleep 30`, 60)
	panel.add("c2", `echo should-not-run`, 60)
	s.schedule(Config{}, "c1")
	s.schedule(Config{}, "c2")
	time.Sleep(300 * time.Millisecond)
	s.cancel("c2")
	s.cancel("c1")
	result := panel.wait(t, "c1")
	if result["cancelled"] != true {
		t.Fatalf("running task not reported cancelled: %+v", result)
	}
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child of the cancelled command kept running")
	}
	panel.mu.Lock()
	defer panel.mu.Unlock()
	for _, id := range panel.pulled {
		if id == "c2" {
			t.Fatal("a cancelled queued task was still pulled")
		}
	}
}

func TestHostCommandTimeoutAndForeignTask(t *testing.T) {
	panel := newFakeCommandPanel()
	s := panel.scheduler()
	panel.add("d1", `sleep 30`, 1)
	s.schedule(Config{}, "d1")
	if result := panel.wait(t, "d1"); result["timedOut"] != true {
		t.Fatalf("result = %+v", result)
	}
	// The panel refuses (expired, cancelled or another host's task): nothing runs or reports.
	s.schedule(Config{}, "d2")
	select {
	case id := <-panel.done:
		t.Fatalf("unexpected report for %s", id)
	case <-time.After(500 * time.Millisecond):
	}
	if s.schedule(Config{}, "not-hex!") || s.schedule(Config{}, strings.Repeat("a", 65)) {
		t.Fatal("invalid task ids accepted")
	}
}

func TestHostCommandPullErrorDoesNotBlockQueue(t *testing.T) {
	panel := newFakeCommandPanel()
	failing := true
	s := newHostCommandScheduler(func(cfg Config, taskID string) (hostCommandPull, error) {
		if taskID == "e1" && failing {
			return hostCommandPull{}, errors.New("network down")
		}
		return hostCommandPull{Success: true, TaskID: taskID, Command: "echo ok", TimeoutSeconds: 10}, nil
	}, func(_ Config, result map[string]any) error {
		// Store before signalling: wait reads the result as soon as it hears the id.
		panel.mu.Lock()
		panel.results[result["taskId"].(string)] = result
		panel.mu.Unlock()
		panel.done <- result["taskId"].(string)
		return nil
	}, &strings.Builder{})
	s.schedule(Config{}, "e1")
	s.schedule(Config{}, "e2")
	if panel.wait(t, "e2")["exitCode"] != 0 {
		t.Fatal("queue stalled after a pull error")
	}
}
