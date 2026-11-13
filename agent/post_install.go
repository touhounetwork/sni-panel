package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Post-install hook: run by the installer after a successful install or
// upgrade (`forwardx-agent -config ... -post-install install|upgrade`). The
// command is fetched over the encrypted channel with this Agent's own token,
// never embedded in the public install script, and its result is reported
// back. Every failure is a warning only: the Agent is already running.

const (
	postInstallTimeout        = 10 * time.Minute
	postInstallMaxReportBytes = 1024 * 1024
)

var postInstallHookTimeout = postInstallTimeout

type installHookStep struct {
	Source  string `json:"source"`
	Command string `json:"command"`
}

type installHookResponse struct {
	Success bool              `json:"success"`
	HostID  int               `json:"hostId"`
	Source  string            `json:"source"`
	Steps   []installHookStep `json:"steps"`
}

// tailBuffer keeps only the last limit bytes written to it.
type tailBuffer struct {
	mu        sync.Mutex
	limit     int
	buf       []byte
	truncated bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.limit; over > 0 {
		t.buf = append([]byte(nil), t.buf[over:]...)
		t.truncated = true
	}
	return len(p), nil
}

func (t *tailBuffer) snapshot() (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(string(t.buf), ""), t.truncated
}

func runPostInstall(cfg Config, mode string, out io.Writer) int {
	if mode != "install" && mode != "upgrade" {
		fmt.Fprintf(out, "[警告] 未知的自定义命令阶段 %q，已跳过\n", mode)
		return 0
	}
	var hook installHookResponse
	if err := postOnce(cfg, "/api/agent/install-hook", map[string]any{"mode": mode, "agentVersion": Version}, &hook); err != nil {
		fmt.Fprintf(out, "[警告] 无法从面板获取自定义命令，已跳过: %v\n", err)
		return 0
	}
	steps := make([]installHookStep, 0, len(hook.Steps))
	for _, step := range hook.Steps {
		if strings.TrimSpace(step.Command) != "" {
			steps = append(steps, step)
		}
	}
	if len(steps) == 0 {
		fmt.Fprintln(out, "[信息] 未配置安装后自定义命令")
		return 0
	}
	fmt.Fprintf(out, "[信息] 执行安装后自定义命令（来源: %s，超时 %s）...\n", hookSourceLabel(hook.Source), postInstallHookTimeout)
	result := executePostInstallSteps(steps, mode, hook.HostID, currentPanelURL(cfg), out)
	result["source"] = hook.Source
	var reported struct {
		Success bool `json:"success"`
	}
	if err := postOnce(cfg, "/api/agent/install-hook-result", result, &reported); err != nil {
		fmt.Fprintf(out, "[警告] 自定义命令结果回报失败: %v\n", err)
	} else if !reported.Success {
		fmt.Fprintln(out, "[警告] 面板未保存自定义命令结果")
	}
	switch {
	case result["timedOut"] == true:
		fmt.Fprintf(out, "[警告] 自定义命令超时（%s），已终止；Agent 安装不受影响\n", postInstallHookTimeout)
	case result["exitCode"] != 0:
		fmt.Fprintf(out, "[警告] 自定义命令退出码 %v；Agent 安装不受影响\n", result["exitCode"])
	default:
		fmt.Fprintln(out, "[信息] 自定义命令执行完成")
	}
	return 0
}

func hookSourceLabel(source string) string {
	switch source {
	case "host":
		return "本节点"
	case "global+host":
		return "全局 + 本节点"
	default:
		return "全局"
	}
}

func executePostInstallCommand(command, mode string, hostID int, panelURL string, out io.Writer) map[string]any {
	return executePostInstallSteps([]installHookStep{{Command: command}}, mode, hostID, panelURL, out)
}

// executePostInstallSteps runs each step as its own process, in order, under
// one shared timeout: a step's exit or syntax error cannot skip the next one.
// The reported exit code is the first non-zero one; a timeout stops the rest.
func executePostInstallSteps(steps []installHookStep, mode string, hostID int, panelURL string, out io.Writer) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), postInstallHookTimeout)
	defer cancel()
	tail := &tailBuffer{limit: postInstallMaxReportBytes}
	// Live output for the installer terminal / upgrade log; the tail is reported.
	writer := io.MultiWriter(out, tail)
	started := time.Now()
	exitCode := 0
	timedOut := false
	for _, step := range steps {
		if len(steps) > 1 {
			fmt.Fprintf(writer, "=== %s命令 ===\n", hookSourceLabel(step.Source))
		}
		code := runPostInstallStep(ctx, step.Command, mode, hostID, panelURL, writer, tail)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			timedOut = true
			break
		}
		if exitCode == 0 && code != 0 {
			exitCode = code
		}
	}
	output, truncated := tail.snapshot()
	return map[string]any{
		"runMode":         mode,
		"agentVersion":    Version,
		"exitCode":        exitCode,
		"timedOut":        timedOut,
		"durationMs":      time.Since(started).Milliseconds(),
		"output":          output,
		"outputTruncated": truncated,
	}
}

func runPostInstallStep(ctx context.Context, command, mode string, hostID int, panelURL string, writer, tail io.Writer) int {
	return runShellInGroup(ctx, command, []string{
		"FORWARDX_INSTALL_MODE=" + mode,
		"FORWARDX_AGENT_VERSION=" + Version,
		"FORWARDX_HOST_ID=" + strconv.Itoa(hostID),
		"FORWARDX_PANEL_URL=" + panelURL,
	}, writer, tail)
}

// runShellInGroup runs /bin/sh -c command in its own process group; when ctx
// ends the whole group is killed. Returns the exit code, or -1 if the command
// could not run (the reason is written to tail).
func runShellInGroup(ctx context.Context, command string, env []string, writer, tail io.Writer) int {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	configurePluginTaskCommand(cmd)
	cmd.WaitDelay = 5 * time.Second
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = writer
	cmd.Stderr = writer
	cmd.Stdin = bytes.NewReader(nil)
	err := cmd.Run()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
		return exitErr.ExitCode()
	}
	if ctx.Err() != nil {
		return -1
	}
	fmt.Fprintf(tail, "\n[forwardx] %v\n", err)
	return -1
}
