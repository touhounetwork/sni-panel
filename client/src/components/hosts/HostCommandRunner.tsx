import { useEffect, useMemo, useState } from "react";
import { Ban, History, Loader2, Play, RotateCcw } from "lucide-react";
import { t as translateText } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

import {
  HOST_COMMAND_DEFAULT_TIMEOUT_SECONDS as DEFAULT_TIMEOUT,
  HOST_COMMAND_MAX_TIMEOUT_SECONDS as MAX_TIMEOUT,
  HOST_COMMAND_MIN_AGENT_VERSION as MIN_AGENT_VERSION,
  HOST_COMMAND_MIN_TIMEOUT_SECONDS as MIN_TIMEOUT,
} from "@shared/hostCommands";

type Status = "queued" | "running" | "success" | "failed" | "timeout" | "cancelled" | "undelivered" | "unsupported";

const STATUS_LABEL: Record<Status, string> = {
  queued: translateText("等待执行"),
  running: translateText("执行中"),
  success: translateText("成功"),
  failed: translateText("失败"),
  timeout: translateText("超时"),
  cancelled: translateText("已取消"),
  undelivered: translateText("未送达"),
  unsupported: translateText("版本不支持"),
};

const STATUS_CLASS: Record<Status, string> = {
  queued: "border-border text-muted-foreground",
  running: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  success: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-500/40 text-red-600 dark:text-red-400",
  timeout: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  cancelled: "border-border text-muted-foreground",
  undelivered: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  unsupported: "border-amber-500/40 text-amber-600 dark:text-amber-400",
};

function versionAtLeast(version: string, minimum: string) {
  const parse = (value: string) => value.replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "-";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatTime(seconds: number | null) {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "-";
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={`gap-1 text-xs ${STATUS_CLASS[status] || ""}`}>
      {status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
      {STATUS_LABEL[status] || status}
    </Badge>
  );
}

function CountsLine({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <span className="text-xs text-muted-foreground">
      {entries.map(([status, n]) => `${STATUS_LABEL[status as Status] || status} ${n}`).join(" · ")}
    </span>
  );
}

/** Admin-only: run one shell command on selected nodes and collect each result. */
export function HostCommandRunner({ searchQuery = "", onFilterStatsChange }: {
  searchQuery?: string;
  onFilterStatsChange?: (stats: { filtered: number; total: number }) => void;
}) {
  const confirm = useConfirmDialog();
  const utils = trpc.useUtils();
  const { data: hosts = [] } = trpc.hosts.options.useQuery(undefined, { refetchOnWindowFocus: false });
  const { data: groups = [] } = trpc.hosts.hostGroups.useQuery(undefined, { refetchOnWindowFocus: false });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [command, setCommand] = useState("");
  const [timeoutText, setTimeoutText] = useState(String(DEFAULT_TIMEOUT));
  const [batchId, setBatchId] = useState<number | null>(null);

  const batchQuery = trpc.hosts.commandBatch.useQuery(
    { batchId: batchId ?? 0 },
    { enabled: batchId !== null, refetchInterval: (query) => (query.state.data && !query.state.data.done ? 1500 : false) },
  );
  const historyQuery = trpc.hosts.commandBatches.useQuery(undefined, { refetchOnWindowFocus: false });
  const refreshHistory = () => Promise.all([utils.hosts.commandBatches.invalidate(), utils.hosts.managementCounts.invalidate()]);

  const run = trpc.hosts.runCommand.useMutation({
    onSuccess: (batch) => {
      if (!batch) return;
      setBatchId(batch.id);
      utils.hosts.commandBatch.setData({ batchId: batch.id }, batch);
      void refreshHistory();
    },
    onError: (error) => toast.error(error.message),
  });
  const cancel = trpc.hosts.cancelCommand.useMutation({
    onSuccess: (batch) => {
      if (batch) utils.hosts.commandBatch.setData({ batchId: batch.id }, batch);
      void refreshHistory();
    },
    onError: (error) => toast.error(error.message),
  });

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleHosts = useMemo(() => (hosts as any[]).filter((host) => !normalizedSearch
    || [host.name, host.ip, host.agentVersion].some((value) => String(value || "").toLowerCase().includes(normalizedSearch))), [hosts, normalizedSearch]);
  useEffect(() => {
    onFilterStatsChange?.({ filtered: visibleHosts.length, total: hosts.length });
  }, [hosts.length, onFilterStatsChange, visibleHosts.length]);

  const timeoutSeconds = Number(timeoutText);
  const timeoutValid = Number.isInteger(timeoutSeconds) && timeoutSeconds >= MIN_TIMEOUT && timeoutSeconds <= MAX_TIMEOUT;
  const canRun = selected.size > 0 && command.trim().length > 0 && timeoutValid && !run.isPending;

  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectIds = (ids: number[]) => setSelected(new Set(ids));

  const submit = async () => {
    const ok = await confirm({
      title: translateText("确认执行命令"),
      description: translateText("将以 root 身份在 {0} 台节点上执行这条命令，执行后无法撤回。离线或 Agent 低于 {1} 的节点不会执行。", [selected.size, MIN_AGENT_VERSION]),
      confirmText: translateText("执行"),
      tone: "destructive",
    });
    if (ok) run.mutate({ hostIds: [...selected], command, timeoutSeconds });
  };

  const batch = batchQuery.data;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground sm:text-sm">
        {translateText("以 root 身份用 /bin/sh 在选定节点上执行命令。每台节点一次只执行一条，其余排队；离线节点不会补发。历史保留 30 天，审计只记录命令摘要。")}
      </p>

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-sm font-medium">{translateText("目标节点")}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{translateText("已选 {0} 台", [selected.size])}</span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs"
                onClick={() => selectIds(visibleHosts.filter((host) => host.isOnline).map((host) => Number(host.id)))}>
                {translateText("选择在线节点")}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => selectIds([])}>
                {translateText("清空")}
              </Button>
            </div>
          </div>
          {(groups as any[]).length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{translateText("按分组：")}</span>
              {(groups as any[]).map((group) => (
                <Button key={group.id} type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs"
                  onClick={() => setSelected((current) => new Set([...current, ...(group.members || []).map((member: any) => Number(member.hostId))]))}>
                  + {group.name}
                </Button>
              ))}
            </div>
          )}
          <div className="grid max-h-64 gap-1 overflow-auto rounded-md border border-border/50 p-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleHosts.map((host) => {
              const id = Number(host.id);
              const supported = versionAtLeast(String(host.agentVersion || ""), MIN_AGENT_VERSION);
              return (
                <label key={id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50">
                  <input type="checkbox" className="h-3.5 w-3.5" checked={selected.has(id)} onChange={() => toggle(id)} />
                  <span className={`h-2 w-2 shrink-0 rounded-full ${host.isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                  <span className="min-w-0 flex-1 truncate">{host.name}</span>
                  <span className={`shrink-0 text-xs ${supported ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>
                    {host.agentVersion || translateText("未上报")}
                  </span>
                </label>
              );
            })}
            {visibleHosts.length === 0 && <p className="px-1.5 py-1 text-xs text-muted-foreground">{translateText("没有匹配的节点")}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="host-command-text" className="text-sm font-medium">{translateText("命令")}</Label>
            <Textarea
              id="host-command-text"
              className="min-h-28 font-mono text-xs"
              spellCheck={false}
              placeholder={translateText("例如：uptime && df -h /")}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{translateText("可用变量 FORWARDX_HOST_ID、FORWARDX_TASK_ID。输出超过 1MB 时只保留最后 1MB。")}</p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="host-command-timeout" className="text-sm font-medium">{translateText("超时（秒）")}</Label>
              <Input id="host-command-timeout" className="h-8 w-28 text-xs" inputMode="numeric" value={timeoutText} onChange={(event) => setTimeoutText(event.target.value)} />
            </div>
            {!timeoutValid && <p className="pb-2 text-xs text-red-600">{translateText("超时必须在 {0} 秒到 {1} 秒之间", [MIN_TIMEOUT, MAX_TIMEOUT])}</p>}
            <Button type="button" className="ml-auto gap-2" disabled={!canRun} onClick={() => void submit()}>
              {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {translateText("执行")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {batch && (
        <Card>
          <CardContent className="space-y-3 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{translateText("批次 #{0}", [batch.id])}</span>
              <span className="text-xs text-muted-foreground">{formatTime(batch.createdAt)} · {batch.createdByName || "-"}</span>
              <CountsLine counts={batch.counts} />
              {!batch.done && (
                <Button type="button" size="sm" variant="outline" className="ml-auto h-7 gap-1 text-xs" disabled={cancel.isPending}
                  onClick={() => cancel.mutate({ batchId: batch.id })}>
                  <Ban className="h-3.5 w-3.5" />{translateText("取消整批")}
                </Button>
              )}
            </div>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 px-2 py-1.5 font-mono text-xs">{batch.command}</pre>
            <div className="space-y-1.5">
              {batch.results.map((result) => (
                <details key={result.taskId} className="rounded border border-border/50 px-2 py-1.5 text-xs">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <span className="font-medium">{result.hostName}</span>
                    <StatusBadge status={result.status} />
                    {result.exitCode !== null && <span className="text-muted-foreground">{translateText("退出码 {0}", [result.exitCode])}</span>}
                    <span className="text-muted-foreground">{formatDuration(result.durationMs)}</span>
                    {(result.status === "queued" || result.status === "running") && (
                      <Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" disabled={cancel.isPending}
                        onClick={(event) => { event.preventDefault(); cancel.mutate({ batchId: batch.id, hostId: result.hostId }); }}>
                        {translateText("取消")}
                      </Button>
                    )}
                  </summary>
                  {result.outputTruncated && <p className="mt-1 text-muted-foreground">{translateText("输出超过 1MB，仅保留最后 1MB。")}</p>}
                  <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono">{result.output || translateText("（无输出）")}</pre>
                </details>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-2 pt-4">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{translateText("最近 30 天的执行记录")}</span>
          </div>
          {(historyQuery.data || []).length === 0 && <p className="text-xs text-muted-foreground">{translateText("暂无记录")}</p>}
          {(historyQuery.data || []).map((item) => (
            <div key={item.id} className={`flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-xs ${item.id === batchId ? "bg-muted/60" : "hover:bg-muted/40"}`}>
              <button type="button" className="min-w-0 flex-1 truncate text-left font-mono" title={item.command} onClick={() => setBatchId(item.id)}>
                #{item.id} {item.command.split("\n")[0]}
              </button>
              <span className="text-muted-foreground">{formatTime(item.createdAt)} · {item.createdByName || "-"} · {translateText("{0} 台", [item.hostCount])}</span>
              <CountsLine counts={item.counts} />
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" title={translateText("用这条命令再执行")}
                onClick={() => setCommand(item.command)}>
                <RotateCcw className="h-3 w-3" />{translateText("再执行")}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
