"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { HostPatchPlan, JobRun } from "@repo/contracts";
import {
  useResourceScope,
  useScopedResource,
  useScopedMutation,
} from "@/hooks/use-scoped-resource";
import { useI18n } from "@/components/i18n-provider";
import { JobRunOutput } from "@/components/jobs/JobRunOutput";
import { Button } from "@/components/ui/button";
import { serverSecurityApi } from "@/lib/api/server-security";

export function ServerSecurityRuns({ serverId }: { serverId: string }) {
  const scope = useResourceScope();
  return <ServerRuns key={`${scope}:${serverId}`} serverId={serverId} />;
}
function ServerRuns({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const c = t.projectSettings.hostSecurity;
  const a = t.projectSettings.securityAdvisories;
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [plan, setPlan] = useState<HostPatchPlan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data: status } = await serverSecurityApi.get(serverId);
    const runs = status.canManage ? (await serverSecurityApi.runs(serverId)).data : [];
    return { status, runs };
  }, [serverId]);
  const resource = useScopedResource(load, 60_000);
  const mutation = useScopedMutation();
  const status = resource.data?.status;
  const busy = mutation.busy;
  const error = mutation.error ?? resource.error;
  useEffect(() => {
    if (!resource.data) return;
    setRuns(resource.data.runs);
    setSelected(
      (current) =>
        current ?? resource.data!.runs.find((run) => run.status === "running")?.id ?? null,
    );
  }, [resource.data]);
  const act = async <T,>(work: () => Promise<T>) => {
    const result = await mutation.execute(work);
    if (result !== null) resource.refresh();
    return result;
  };
  const prepare = async (advisoryId: string, operation: "install" | "reboot" = "install") => {
    const result = await act(() => serverSecurityApi.plan(serverId, advisoryId, operation));
    if (result) setPlan(result.data);
  };
  const apply = async () => {
    if (!plan) return;
    const result = await act(() => serverSecurityApi.apply(serverId, plan.token));
    if (result) {
      setSelected(result.data.runId);
      setPlan(null);
    }
  };
  const runLabel = (run: JobRun) => {
    if (run.status === "failed") return c.needsReview;
    const phase = run.summary?.phase;
    return phase === "rebooting"
      ? c.rebooting
      : phase === "reboot_required"
        ? c.rebootRequired
        : phase === "verified"
          ? c.verified
          : t.jobs.status.running;
  };
  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">{c.title}</h2>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !status?.checksEnabled || !status.supported || !status.canManage}
            onClick={() =>
              void act(async () => {
                setPlan(null);
                await serverSecurityApi.check(serverId);
              })
            }
          >
            {busy ? a.checking : a.checkAgain}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {!status ? (
          <div
            className="h-20 animate-pulse motion-reduce:animate-none rounded-xl bg-muted"
            aria-label={a.checking}
          />
        ) : (
          <>
            {!status.supported && <p className="text-sm text-muted-foreground">{c.notSupported}</p>}
            {!status.checksEnabled && (
              <p role="status" className="text-sm text-muted-foreground">
                {a.checksDisabled}{" "}
                <Link className="underline" href="/settings?tab=notifications">
                  {a.manageChecks}
                </Link>
              </p>
            )}
            {(status.error || status.feedStale) && (
              <p className="text-sm text-muted-foreground">{a.unavailable}</p>
            )}
            {status.pending && (
              <p role="status" className="text-sm text-muted-foreground">
                {c.checkPending}
              </p>
            )}
            {status.checkedAt && (
              <p className="text-xs text-muted-foreground">
                {a.checked}: {new Date(status.checkedAt).toLocaleString()}
                {status.nextCheckAt && (
                  <>
                    {" "}
                    · {c.nextCheck}: {new Date(status.nextCheckAt).toLocaleString()}
                  </>
                )}
              </p>
            )}
            {status.supported &&
              status.checksEnabled &&
              status.checkedAt &&
              !status.pending &&
              !status.error &&
              !status.feedStale &&
              !status.findings.length && (
                <p className="text-sm text-muted-foreground">{a.noMatches}</p>
              )}
            {status.findings.map((f) => (
              <article key={f.id} className="rounded-xl bg-background p-4 space-y-2">
                <h3 className="text-sm font-medium">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.message}</p>
                <p className="break-words font-mono text-xs text-muted-foreground">
                  {f.evidence.join(" · ")}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm underline"
                  >
                    {a.guidance}
                  </a>
                  {f.canPatch ? (
                    <Button
                      size="sm"
                      disabled={busy || runs.some((r) => r.status === "running")}
                      onClick={() => void prepare(f.id)}
                    >
                      {c.reviewPatch}
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {f.state === "reboot_required" ? c.rebootRequired : c.manual}
                    </span>
                  )}
                  {f.canReboot && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || runs.some((r) => r.status === "running")}
                      onClick={() => void prepare(f.id, "reboot")}
                    >
                      {c.reviewReboot}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </>
        )}
        {plan && (
          <div
            className="rounded-xl bg-background p-4 space-y-3"
            role="region"
            aria-label={c.patchDetails}
          >
            <h3 className="font-medium">{plan.title}</h3>
            <p className="text-sm text-muted-foreground">
              {plan.operation === "reboot" ? c.rebootInterruption : c.interruption}
            </p>
            {plan.rebootRequired && <p className="text-sm text-warning">{c.rebootRequired}</p>}
            {!!plan.changes.length && (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-xs">
                  <thead>
                    <tr>
                      <th scope="col" className="py-2">
                        {c.package}
                      </th>
                      <th scope="col">{c.current}</th>
                      <th scope="col">{c.target}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.changes.map((change) => (
                      <tr key={change.package}>
                        <td className="py-1 font-mono">{change.package}</td>
                        <td>{change.previous ?? "—"}</td>
                        <td>{change.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                disabled={
                  busy ||
                  Date.parse(plan.expiresAt) <= Date.now() ||
                  !status?.checksEnabled ||
                  !status.canManage ||
                  !status.supported ||
                  status.feedStale
                }
                onClick={() => void apply()}
              >
                {plan.operation === "reboot" ? c.applyReboot : c.applyPatch}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setPlan(null)}>
                {t.projectSettings.settingSection.cancel}
              </Button>
            </div>
          </div>
        )}
      </section>
      <section className="rounded-2xl bg-card p-5 space-y-3">
        <h2 className="font-medium">{c.runs}</h2>
        {!runs.length && <p className="text-sm text-muted-foreground">{c.noRuns}</p>}
        {runs.map((run) => (
          <div key={run.id} className="rounded-xl bg-background p-3">
            <button
              className="flex w-full flex-wrap justify-between gap-2 text-left text-sm"
              aria-expanded={selected === run.id}
              onClick={() => setSelected(selected === run.id ? null : run.id)}
            >
              <span>
                {String(run.summary?.advisoryId ?? run.jobId)} ·{" "}
                {new Date(run.startedAt).toLocaleString()}
              </span>
              <span>{runLabel(run)}</span>
            </button>
            {selected === run.id && (
              <div className="mt-3">
                <JobRunOutput
                  key={run.id}
                  run={run}
                  path={`system/servers/${encodeURIComponent(serverId)}/security/runs/${encodeURIComponent(run.id)}/stream`}
                  onSnapshot={(snapshot) => {
                    setRuns((current) =>
                      current.map((item) => (item.id === snapshot.id ? snapshot : item)),
                    );
                    if (run.status === "running" && snapshot.status !== "running")
                      resource.refresh();
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
