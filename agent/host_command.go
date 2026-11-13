package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Admin batch commands. The event stream only carries a task id; the command
// is pulled over the encrypted channel with this Agent's token, run as root
// one at a time, and the result is reported back. Cancel events stop a
// running command's process group or drop it from the queue.

const (
	hostCommandMaxQueued     = 4
	hostCommandMaxTaskIDLen  = 64
	hostCommandSeenRetention = time.Hour
)

type hostCommandRequest struct {
	TaskID string `json:"taskId"`
}

type hostCommandPull struct {
	Success        bool   `json:"success"`
	HostID         int    `json:"hostId"`
	TaskID         string `json:"taskId"`
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

type hostCommandScheduler struct {
	mu        sync.Mutex
	running   string
	cancelRun context.CancelFunc
	cancelled map[string]bool
	queue     []string
	seen      map[string]time.Time
	cfg       Config
	pull      func(Config, string) (hostCommandPull, error)
	report    func(Config, map[string]any) error
	out       io.Writer
}

var agentHostCommands = newHostCommandScheduler(
	func(cfg Config, taskID string) (hostCommandPull, error) {
		var pulled hostCommandPull
		err := postOnce(cfg, "/api/agent/command-pull", map[string]any{"taskId": taskID}, &pulled)
		return pulled, err
	},
	func(cfg Config, result map[string]any) error {
		// The result is the only record of the run: retry briefly.
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			var reply struct {
				Success bool `json:"success"`
			}
			if err = postOnce(cfg, "/api/agent/command-result", result, &reply); err == nil {
				return nil
			}
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
		}
		return err
	},
	io.Discard,
)

func newHostCommandScheduler(pull func(Config, string) (hostCommandPull, error), report func(Config, map[string]any) error, out io.Writer) *hostCommandScheduler {
	return &hostCommandScheduler{cancelled: map[string]bool{}, seen: map[string]time.Time{}, pull: pull, report: report, out: out}
}

func validHostCommandTaskID(taskID string) bool {
	if taskID == "" || len(taskID) > hostCommandMaxTaskIDLen {
		return false
	}
	for _, r := range taskID {
		if !(r >= 'a' && r <= 'f' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// schedule accepts a task id once; duplicate deliveries are ignored.
func (s *hostCommandScheduler) schedule(cfg Config, taskID string) bool {
	taskID = strings.TrimSpace(taskID)
	if !validHostCommandTaskID(taskID) {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	for id, at := range s.seen {
		if now.Sub(at) > hostCommandSeenRetention {
			delete(s.seen, id)
		}
	}
	// One running plus hostCommandMaxQueued waiting.
	if _, dup := s.seen[taskID]; dup || (s.running != "" && len(s.queue) >= hostCommandMaxQueued) {
		s.mu.Unlock()
		return false
	}
	s.seen[taskID] = now
	s.cfg = cfg
	if s.running != "" {
		s.queue = append(s.queue, taskID)
		s.mu.Unlock()
		return true
	}
	s.running = taskID
	s.mu.Unlock()
	go s.drain(taskID)
	return true
}

// cancel stops a running task or removes a queued one.
func (s *hostCommandScheduler) cancel(taskID string) {
	taskID = strings.TrimSpace(taskID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelled[taskID] = true
	if s.running == taskID && s.cancelRun != nil {
		s.cancelRun()
	}
	for i, queued := range s.queue {
		if queued == taskID {
			s.queue = append(s.queue[:i], s.queue[i+1:]...)
			break
		}
	}
}

func (s *hostCommandScheduler) drain(taskID string) {
	for {
		s.mu.Lock()
		cfg := s.cfg
		s.mu.Unlock()
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					logf("host command panicked task=%s error=%v", taskID, recovered)
				}
			}()
			s.runOne(cfg, taskID)
		}()
		s.mu.Lock()
		delete(s.cancelled, taskID)
		s.cancelRun = nil
		if len(s.queue) == 0 {
			s.running = ""
			s.mu.Unlock()
			return
		}
		taskID = s.queue[0]
		s.queue = s.queue[1:]
		s.running = taskID
		s.mu.Unlock()
	}
}

func (s *hostCommandScheduler) runOne(cfg Config, taskID string) {
	pulled, err := s.pull(cfg, taskID)
	if err != nil {
		logf("host command pull failed task=%s: %v", taskID, err)
		return
	}
	if !pulled.Success || strings.TrimSpace(pulled.Command) == "" {
		// Cancelled, expired or not ours: nothing to run.
		return
	}
	timeout := time.Duration(pulled.TimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > time.Hour {
		timeout = 5 * time.Minute
	}
	ctx, cancelTimeout := context.WithTimeout(context.Background(), timeout)
	ctx, cancelRun := context.WithCancel(ctx)
	defer cancelTimeout()
	defer cancelRun()
	s.mu.Lock()
	s.cancelRun = cancelRun
	alreadyCancelled := s.cancelled[taskID]
	s.mu.Unlock()
	if alreadyCancelled {
		cancelRun()
	}
	result := runHostCommand(ctx, pulled.Command, []string{
		"FORWARDX_HOST_ID=" + strconv.Itoa(pulled.HostID),
		"FORWARDX_TASK_ID=" + taskID,
	}, s.out)
	result["taskId"] = taskID
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		result["timedOut"] = true
	} else if errors.Is(ctx.Err(), context.Canceled) {
		result["cancelled"] = true
	}
	if err := s.report(cfg, result); err != nil {
		logf("host command result report failed task=%s: %v", taskID, err)
	}
}

// runHostCommand runs one /bin/sh command in its own process group until it
// exits or ctx ends, keeping the last 1MB of combined output.
func runHostCommand(ctx context.Context, command string, env []string, live io.Writer) map[string]any {
	tail := &tailBuffer{limit: postInstallMaxReportBytes}
	writer := io.MultiWriter(live, tail)
	started := time.Now()
	code := runShellInGroup(ctx, command, env, writer, tail)
	output, truncated := tail.snapshot()
	return map[string]any{
		"exitCode":        code,
		"durationMs":      time.Since(started).Milliseconds(),
		"output":          output,
		"outputTruncated": truncated,
	}
}

func handleHostCommandEvent(cfg Config, eventType string, data []byte) {
	var request hostCommandRequest
	if err := json.Unmarshal(data, &request); err != nil {
		logf("decode %s payload: %v", eventType, err)
		return
	}
	switch eventType {
	case "agent-command":
		if !agentHostCommands.schedule(cfg, request.TaskID) {
			logf("host command not accepted task=%s (duplicate, invalid or queue full)", compactLogField(request.TaskID, hostCommandMaxTaskIDLen))
		}
	case "agent-command-cancel":
		agentHostCommands.cancel(request.TaskID)
	}
}
