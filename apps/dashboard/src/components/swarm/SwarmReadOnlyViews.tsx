import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { SwarmNode, SwarmTask } from "@/lib/api/swarm";

export function formatObservedAt(value: string | null | undefined): string {
  if (!value) return "Not observed yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function shortId(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}${value.length > 12 ? "…" : ""}` : "—";
}

export function HealthBadge({ state }: { state: string }) {
  const normalized = state.replaceAll("_", " ");
  const common = "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize";
  if (state === "ready" || state === "converged" || state === "clean") {
    return <span className={`${common} bg-success/10 text-success`}><CheckCircle2 className="size-3" />{normalized}</span>;
  }
  if (state === "failed" || state === "partial_failure" || state === "degraded" || state === "drifted" || state === "unreachable") {
    return <span className={`${common} bg-danger-bg text-danger`}><XCircle className="size-3" />{normalized}</span>;
  }
  if (state === "paused") {
    return <span className={`${common} bg-warning/10 text-warning`}><AlertTriangle className="size-3" />{normalized}</span>;
  }
  return <span className={`${common} bg-muted text-muted-foreground`}><CircleDashed className="size-3" />{normalized}</span>;
}

export function SwarmNodesTable({ nodes }: { nodes: SwarmNode[] }) {
  if (nodes.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No nodes were returned by this manager.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[580px] text-left text-sm">
        <thead className="border-b border-border/50 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Node</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Availability</th>
            <th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Engine</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {nodes.map((node) => (
            <tr key={node.id}>
              <td className="px-4 py-3 font-medium text-foreground">
                <div>{node.hostname}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{shortId(node.id)}</div>
              </td>
              <td className="px-4 py-3"><HealthBadge state={node.status.toLowerCase()} /></td>
              <td className="px-4 py-3 text-muted-foreground capitalize">{node.availability}</td>
              <td className="px-4 py-3 text-muted-foreground">{node.managerStatus || "Worker"}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{node.engineVersion || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SwarmTasksTable({ tasks, onLogs }: { tasks: SwarmTask[]; onLogs?: (task: SwarmTask) => void }) {
  if (tasks.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No current tasks were returned for this stack.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="border-b border-border/50 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Service</th>
            <th className="px-4 py-3">Task</th>
            <th className="px-4 py-3">Node</th>
            <th className="px-4 py-3">Current state</th>
            <th className="px-4 py-3">Desired</th>
            {onLogs && <th className="px-4 py-3">Logs</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {tasks.map((task) => (
            <tr key={task.id}>
              <td className="px-4 py-3 font-medium text-foreground">{task.serviceName}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{shortId(task.id)}{task.slot ? ` · ${task.slot}` : ""}</td>
              <td className="px-4 py-3 text-muted-foreground">{task.nodeName || "Unassigned"}</td>
              <td className="px-4 py-3">
                <span className={task.error ? "text-danger" : "text-foreground"}>{task.currentState}</span>
                {task.error && <p className="mt-1 max-w-64 text-xs text-danger">{task.error}</p>}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{task.desiredState}</td>
              {onLogs && <td className="px-4 py-3"><button type="button" onClick={() => onLogs(task)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted">Logs</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
