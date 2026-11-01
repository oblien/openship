"use client";
import { useState } from "react";
import { inspectCommandEnvironment } from "@repo/core";
import { Button } from "@/components/ui/button";
import { api, getApiRequestScopeVersion } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api";

type Commands = Partial<Record<"installCommand" | "buildCommand" | "startCommand", string | null>>;
export function CommandEnvironmentNotice({
  commands,
  projectId,
  serviceId,
  onMigrated,
  migrateDraft,
}: {
  commands: Commands;
  projectId?: string;
  serviceId?: string;
  onMigrated?: (commands: Record<string, string>) => void | Promise<void>;
  migrateDraft?: (commands: Record<string, string>, variables: Record<string, string>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const entries = (["installCommand", "buildCommand", "startCommand"] as const)
    .map((field) => ({
      field,
      command: commands[field] ?? "",
      parsed: inspectCommandEnvironment(commands[field] ?? ""),
    }))
    .filter((row) => row.parsed.keys.length);
  if (!entries.length) return null;
  const migrate = async () => {
    const scope = getApiRequestScopeVersion();
    setBusy(true);
    setError("");
    try {
      const selected = Object.fromEntries(entries.map((row) => [row.field, row.command]));
      if (migrateDraft) {
        const variables: Record<string, string> = {};
        for (const row of entries)
          for (const [key, value] of Object.entries(row.parsed.variables)) {
            if (Object.hasOwn(variables, key) && variables[key] !== value)
              throw new Error(
                `Commands use different values for ${key}. Resolve the difference first.`,
              );
            variables[key] = value;
          }
        migrateDraft(
          Object.fromEntries(entries.map((row) => [row.field, row.parsed.command])),
          variables,
        );
      } else if (projectId) {
        const result = await api.post<{ data: { commands: Record<string, string> } }>(
          `projects/${encodeURIComponent(projectId)}/env/migrate-commands`,
          { environment: "production", serviceId, commands: selected },
        );
        if (scope === getApiRequestScopeVersion()) await onMigrated?.(result.data.commands);
      }
    } catch (cause) {
      // User-facing validation is retained in the form; command values stay out of diagnostics.
      if (scope === getApiRequestScopeVersion())
        setError(
          getApiErrorMessage(
            cause,
            cause instanceof Error ? cause.message : "Could not move command variables.",
          ),
        );
    } finally {
      if (scope === getApiRequestScopeVersion()) setBusy(false);
    }
  };
  return (
    <div className="rounded-xl bg-warning-bg p-4 text-sm" role="status">
      <p className="font-medium text-foreground">Manage command variables in Environment</p>
      <p className="mt-1 text-muted-foreground">
        Embedded variables: {[...new Set(entries.flatMap((row) => row.parsed.keys))].join(", ")}.
        Saved variables are available during builds and at runtime.
      </p>
      {entries.every((row) => row.parsed.migratable) && (projectId || migrateDraft) ? (
        <Button type="button" variant="outline" className="mt-3" disabled={busy} onClick={migrate}>
          {busy ? "Moving variables…" : "Move to Environment"}
        </Button>
      ) : (
        <p className="mt-2 text-muted-foreground">
          Review this command manually before moving these variables.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
