import { useEffect, useState } from "react";
import { t as translateText } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** Default post-install command; each host may use it, override it or skip it. */
export function AgentInstallHookGlobalSetting() {
  const utils = trpc.useUtils();
  const query = trpc.hosts.globalInstallHook.useQuery(undefined, { refetchOnWindowFocus: false });
  const save = trpc.hosts.saveGlobalInstallHook.useMutation({
    onSuccess: async () => {
      toast.success(translateText("全局安装后命令已保存"));
      await utils.hosts.globalInstallHook.invalidate();
      await utils.hosts.installHook.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const [command, setCommand] = useState("");
  useEffect(() => { if (query.data) setCommand(query.data.command); }, [query.data]);
  if (!query.data) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3 lg:col-span-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{translateText("Agent 安装／升级后执行命令")}</p>
        <p className="text-xs text-muted-foreground">{translateText("所有节点默认执行；可在主机编辑中改用本节点命令、在其后追加本节点命令，或不执行。以 root 用 /bin/sh 执行，超时 10 分钟，失败不影响 Agent。")}</p>
      </div>
      <Textarea className="min-h-20 font-mono text-xs" spellCheck={false} value={command}
        placeholder={translateText("留空则不执行")} onChange={(event) => setCommand(event.target.value)} />
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" disabled={command === query.data.command || save.isPending}
          onClick={() => save.mutate({ command })}>{translateText("保存命令")}</Button>
      </div>
    </div>
  );
}
