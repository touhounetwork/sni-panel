import { useEffect, useRef } from "react";
import { t as translateText } from "@/i18n";
import { HintSwitch } from "@/components/ui/hint-switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";

export type SniProxyProtocolValue = {
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolVersion: 1 | 2;
};

/**
 * PROXY Protocol switches of a forward group SNI rule. Receive belongs to the
 * entry port: a new rule starts from the port's current value, and saving
 * applies the value to every SNI rule on that port.
 */
export function SniProxyProtocolFields({ forwardGroupId, sourcePort, editingId, value, onChange }: {
  forwardGroupId: number | null;
  sourcePort: number;
  editingId: number | null;
  value: SniProxyProtocolValue;
  onChange: (patch: Partial<SniProxyProtocolValue>) => void;
}) {
  const enabled = !!forwardGroupId && sourcePort > 0;
  const state = trpc.rules.sniPortProxyState.useQuery(
    { forwardGroupId: Number(forwardGroupId), sourcePort, excludeRuleId: editingId || undefined },
    { enabled, staleTime: 10_000 },
  );
  const data = state.data;
  const adoptedPort = useRef<string | null>(null);
  useEffect(() => {
    if (!data || editingId) return;
    const key = `${forwardGroupId}:${sourcePort}`;
    if (adoptedPort.current === key) return;
    adoptedPort.current = key;
    if (data.receive !== null && data.receive !== value.proxyProtocolReceive) onChange({ proxyProtocolReceive: data.receive });
  }, [data, editingId, forwardGroupId, sourcePort, value.proxyProtocolReceive, onChange]);

  if (!enabled || !data) return null;
  const supported = data.supported && !data.reason;
  const receiveBlocked = !supported || !!data.chainShared;
  const disabledReason = data.reason ? translateText(data.reason) : "";
  const siblingNote = data.siblingRuleCount > 0
    ? translateText("接收开关属于入口端口，保存后同步到该端口其他 {0} 条 SNI 规则", [data.siblingRuleCount])
    : translateText("接收开关属于入口端口，之后加入该端口的 SNI 规则会沿用");
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5 sm:col-span-2">
      <Label className="text-sm">PROXY Protocol</Label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex items-center justify-between gap-2 rounded-md bg-background/60 px-3 py-2">
          <span className="text-sm">{translateText("接收 PROXY")}</span>
          <HintSwitch
            aria-label={translateText("接收 PROXY")}
            hint={disabledReason || siblingNote}
            checked={value.proxyProtocolReceive}
            disabled={receiveBlocked && !value.proxyProtocolReceive}
            onCheckedChange={(checked) => onChange({ proxyProtocolReceive: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-md bg-background/60 px-3 py-2">
          <span className="text-sm">{translateText("发送 PROXY")}</span>
          <HintSwitch
            aria-label={translateText("发送 PROXY")}
            hint={disabledReason || translateText("连接落地前先写入 PROXY 头，再转发客户端握手")}
            checked={value.proxyProtocolSend}
            disabled={!supported && !value.proxyProtocolSend}
            onCheckedChange={(checked) => onChange({ proxyProtocolSend: checked })}
          />
        </label>
        <Select
          value={String(value.proxyProtocolVersion)}
          disabled={!value.proxyProtocolSend}
          onValueChange={(next) => onChange({ proxyProtocolVersion: next === "2" ? 2 : 1 })}
        >
          <SelectTrigger aria-label={translateText("PROXY 版本")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">PROXY v1</SelectItem>
            <SelectItem value="2">PROXY v2</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">{disabledReason || siblingNote}</p>
    </div>
  );
}
