import { useEffect, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { t as translateText } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Mode = "inherit" | "custom" | "append" | "disabled";

function formatDuration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Admin-only: the command a host runs after an Agent install or upgrade.
 * Saved on its own endpoint, independent of the host dialog's Save button.
 */
export function HostInstallHookSettings({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
  const query = trpc.hosts.installHook.useQuery({ hostId }, { refetchOnWindowFocus: false });
  const save = trpc.hosts.saveInstallHook.useMutation({
    onSuccess: async () => {
      toast.success(translateText("安装后命令已保存"));
      await utils.hosts.installHook.invalidate({ hostId });
    },
    onError: (error) => toast.error(error.message),
  });
  const [mode, setMode] = useState<Mode>("inherit");
  const [command, setCommand] = useState("");
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    setMode(data.mode);
    setCommand(data.command);
  }, [data]);
  if (!data) return null;
  const dirty = mode !== data.mode || command !== data.command;
  const result = data.lastResult;
  const failed = !!result && (result.timedOut || result.exitCode !== 0);
  return (
    <div className="mt-2.5 space-y-2 rounded-md bg-muted/35 px-3 py-2.5">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Label className="text-sm font-medium">{translateText("安装／升级后执行命令")}</Label>
        </div>
        <Select value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <SelectTrigger className="ml-auto h-8 w-auto min-w-[9rem] text-xs" aria-label={translateText("执行方式")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{translateText("使用全局命令")}</SelectItem>
            <SelectItem value="custom">{translateText("使用本节点命令")}</SelectItem>
            <SelectItem value="append">{translateText("追加本节点命令")}</SelectItem>
            <SelectItem value="disabled">{translateText("不执行")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {(mode === "custom" || mode === "append") && (
        <Textarea
          className="min-h-24 font-mono text-xs"
          spellCheck={false}
          placeholder={translateText("以 root 用 /bin/sh 执行，例如：apt-get install -y htop")}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
      )}
      {mode === "append" && (
        <p className="break-words text-xs text-muted-foreground">
          {data.globalCommand
            ? translateText("先执行系统设置中的全局命令，再执行上面的本节点命令；两段分别执行，其中一段失败不影响另一段。")
            : translateText("系统设置中未配置全局命令，只会执行上面的本节点命令。")}
        </p>
      )}
      {mode === "inherit" && (
        <p className="break-words text-xs text-muted-foreground">
          {data.globalCommand ? translateText("将执行系统设置中的全局命令。") : translateText("系统设置中未配置全局命令，不会执行。")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {translateText("Agent 安装或升级完成后执行，超时 10 分钟；失败只提示，不影响 Agent。可用变量 FORWARDX_INSTALL_MODE、FORWARDX_HOST_ID、FORWARDX_AGENT_VERSION、FORWARDX_PANEL_URL。")}
      </p>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" disabled={!dirty || save.isPending || ((mode === "custom" || mode === "append") && !command.trim())}
          onClick={() => save.mutate({ hostId, mode, command })}>
          {translateText("保存命令")}
        </Button>
      </div>
      {result && (
        <details className="rounded border border-border/50 bg-background/60 px-2 py-1.5 text-xs">
          <summary className={`cursor-pointer ${failed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
            {translateText("最近一次：{0}，{1}，{2}，用时 {3}", [
              new Date(result.runAt * 1000).toLocaleString(),
              result.runMode === "upgrade" ? translateText("升级") : translateText("安装"),
              result.timedOut ? translateText("超时") : translateText("退出码 {0}", [result.exitCode ?? "?"]),
              formatDuration(result.durationMs),
            ])}
          </summary>
          {result.outputTruncated && <p className="mt-1 text-muted-foreground">{translateText("输出超过 1MB，仅保留最后 1MB；完整内容见节点 /var/log/forwardx-agent/ 下的日志。")}</p>}
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono">{result.output || translateText("（无输出）")}</pre>
        </details>
      )}
    </div>
  );
}
