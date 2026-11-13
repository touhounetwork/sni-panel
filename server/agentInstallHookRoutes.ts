import type { Request, Response, Router } from "express";
import { getAgentHostIdentityFromRequest } from "./agentAuth";
import { getInstallHookForAgent, recordInstallHookResult } from "./hostInstallHooks";

// Registered on the fenced Agent API router: a retired installation identity
// is answered as superseded before these handlers run.
export function registerAgentInstallHookRoutes(router: Router) {
  router.post("/api/agent/install-hook", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostIdentityFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const hook = await getInstallHookForAgent(Number(host.id));
      res.json({ success: true, hostId: Number(host.id), source: hook.source, steps: hook.steps });
    } catch (error) {
      console.error("[InstallHook] Lookup failed:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/agent/install-hook-result", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostIdentityFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const ok = await recordInstallHookResult(Number(host.id), req.body || {});
      res.json({ success: ok });
    } catch (error) {
      console.error("[InstallHook] Result report failed:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
