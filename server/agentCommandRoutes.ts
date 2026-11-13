import type { Request, Response, Router } from "express";
import { getAgentHostIdentityFromRequest } from "./agentAuth";
import { recordHostCommandResult, takeHostCommandForAgent } from "./hostCommands";

// On the fenced Agent API router: a retired installation identity is
// answered as superseded before these handlers run.
export function registerAgentCommandRoutes(router: Router) {
  router.post("/api/agent/command-pull", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostIdentityFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const task = await takeHostCommandForAgent(Number(host.id), String(req.body?.taskId || ""));
      res.json(task ? { success: true, hostId: Number(host.id), ...task } : { success: false });
    } catch (error) {
      console.error("[HostCommand] Pull failed:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/agent/command-result", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostIdentityFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      res.json({ success: await recordHostCommandResult(Number(host.id), req.body || {}) });
    } catch (error) {
      console.error("[HostCommand] Result failed:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
