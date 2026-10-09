"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import type { ManagedWorkload, ServerOperations } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { systemApi } from "@/lib/api/system";
import { ManagedControlPanel } from "./ManagedControlPanel";
import { useManagedServerResource } from "./useManagedServerResource";

type CreateInput = Parameters<ServerOperations["createManagedWorkload"]>[1];
type Action = Parameters<ServerOperations["controlManagedWorkload"]>[1]["action"];

export function ManagedServerWorkloads({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const common = t.servers.managedControls,
    copy = common.workloads;
  const resource = useManagedServerResource(serverId, systemApi.managedWorkloads);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [directory, setDirectory] = useState("/root");
  const [environment, setEnvironment] = useState("");
  const [policy, setPolicy] = useState<CreateInput["restartPolicy"]>("on-failure");
  const pendingCreate = useRef<CreateInput | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    workload: ManagedWorkload;
    action: Action;
  } | null>(null);
  const [logs, setLogs] = useState<{
    id: string;
    name: string;
    logs: string;
    truncated: boolean;
  } | null>(null);
  const formId = useId();
  const items = resource.data?.workloads ?? [];

  function resetForm() {
    pendingCreate.current = null;
    setSubmitted(false);
    setCreateOpen(false);
    setName("");
    setCommand("");
    setDirectory("/root");
    setEnvironment("");
    setPolicy("on-failure");
  }
  function create() {
    pendingCreate.current ??= {
      idempotencyKey: crypto.randomUUID(),
      name: name.trim(),
      command,
      workingDirectory: directory,
      environment: environment.split(/\r?\n/).filter((line) => line.trim()),
      restartPolicy: policy,
      confirm: true,
    };
    setSubmitted(true);
    void resource.run(
      () => systemApi.createManagedWorkload(serverId, pendingCreate.current!),
      (workload) => {
        resource.replace({
          workloads: [...items.filter((item) => item.id !== workload.id), workload],
          truncated: resource.data?.truncated ?? false,
        });
        resetForm();
      },
    );
  }
  function control() {
    if (!confirmation) return;
    const { workload, action } = confirmation;
    void resource.run(
      () =>
        systemApi.controlManagedWorkload(serverId, {
          workloadId: workload.id,
          action,
          confirm: true,
        }),
      (result) => {
        resource.replace({
          workloads: items.flatMap((item) =>
            item.id !== workload.id ? [item] : result.workload ? [result.workload] : [],
          ),
          truncated: resource.data?.truncated ?? false,
        });
        setConfirmation(null);
        if (logs?.id === workload.id) setLogs(null);
      },
    );
  }
  return (
    <ManagedControlPanel
      title={copy.title}
      description={copy.description}
      icon="layers"
      {...resource}
    >
      <p className="rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground">{copy.scopeHint}</p>
      {resource.data && (
        <>
          <Button
            variant="secondary"
            disabled={resource.busy}
            onClick={() => setCreateOpen((value) => !value)}
          >
            {copy.create}
          </Button>
          {createOpen && (
            <form
              className="space-y-4 rounded-xl bg-muted/20 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <p className="text-sm text-muted-foreground">{copy.createHint}</p>
              <div className="space-y-2">
                <label htmlFor={`${formId}-name`} className="text-sm font-medium">
                  {copy.name}
                </label>
                <Input
                  id={`${formId}-name`}
                  variant="filled"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={resource.busy || submitted}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor={`${formId}-command`} className="text-sm font-medium">
                  {copy.command}
                </label>
                <Textarea
                  id={`${formId}-command`}
                  variant="filled"
                  className="font-mono text-xs"
                  dir="ltr"
                  rows={3}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  maxLength={16384}
                  required
                  disabled={resource.busy || submitted}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor={`${formId}-directory`} className="text-sm font-medium">
                  {copy.directory}
                </label>
                <Input
                  id={`${formId}-directory`}
                  variant="filled"
                  dir="ltr"
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  maxLength={1024}
                  required
                  disabled={resource.busy || submitted}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor={`${formId}-env`} className="text-sm font-medium">
                  {copy.environment}
                </label>
                <Textarea
                  id={`${formId}-env`}
                  variant="filled"
                  className="font-mono text-xs"
                  dir="ltr"
                  rows={3}
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value)}
                  maxLength={65536}
                  disabled={resource.busy || submitted}
                  spellCheck={false}
                  placeholder="KEY=value"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor={`${formId}-policy`} className="text-sm font-medium">
                  {copy.restartPolicy}
                </label>
                <CustomSelect
                  id={`${formId}-policy`}
                  variant="filled"
                  triggerClassName="bg-muted/60 hover:bg-muted"
                  value={policy}
                  onChange={setPolicy}
                  disabled={resource.busy || submitted}
                  options={[
                    { value: "never", label: copy.never },
                    { value: "on-failure", label: copy.onFailure },
                    { value: "always", label: copy.always },
                  ]}
                />
              </div>
              {submitted && <p className="text-xs text-muted-foreground">{copy.retryHint}</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={resource.busy || !name.trim() || !command.trim()}>
                  {submitted ? copy.retryCreate : copy.createStopped}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resource.busy}
                  onClick={() => {
                    resetForm();
                    resource.refresh();
                  }}
                >
                  {submitted ? copy.closeRequest : common.cancel}
                </Button>
              </div>
            </form>
          )}
          {confirmation && (
            <div className="space-y-3 rounded-xl bg-warning/10 p-4">
              <p className="break-words text-sm">
                {interpolate(copy.confirmAction, {
                  action: copy[confirmation.action],
                  name: confirmation.workload.name,
                })}
              </p>
              {confirmation.action === "delete" && (
                <p className="text-sm text-muted-foreground">{copy.deleteHint}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant={confirmation.action === "start" ? "default" : "destructive"}
                  disabled={resource.busy}
                  onClick={control}
                >
                  {copy[confirmation.action]}
                </Button>
                <Button
                  variant="ghost"
                  disabled={resource.busy}
                  onClick={() => setConfirmation(null)}
                >
                  {common.cancel}
                </Button>
              </div>
            </div>
          )}
          {logs && (
            <div className="space-y-3 rounded-xl bg-muted/30 p-4">
              <h3 className="break-words text-sm font-medium">
                {logs.name} · {copy.logs}
              </h3>
              <pre
                dir="ltr"
                className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs"
              >
                {logs.logs || common.noLogs}
              </pre>
              {logs.truncated && (
                <p className="text-xs text-muted-foreground">{common.logsTruncated}</p>
              )}
              <Button variant="ghost" size="sm" onClick={() => setLogs(null)}>
                {common.close}
              </Button>
            </div>
          )}
          {!items.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">{copy.empty}</p>
          )}
          <div className="space-y-3">
            {items.map((workload) => (
              <article key={workload.id} className="min-w-0 space-y-3 rounded-xl bg-muted/25 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-medium">{workload.name}</h3>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground" dir="ltr">
                      {workload.id}
                    </p>
                  </div>
                  <span className="rounded-full bg-muted/60 px-2 py-1 text-xs">
                    {copy.states[workload.state as keyof typeof copy.states] ?? common.unavailable}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {copy.sources[workload.source]}
                  {workload.restartPolicy
                    ? ` · ${copy.restartPolicy}: ${workload.restartPolicy}`
                    : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={resource.busy}
                    onClick={() => {
                      setLogs(null);
                      void resource.run(
                        () =>
                          systemApi.managedWorkloadLogs(serverId, {
                            workloadId: workload.id,
                            tail: 200,
                          }),
                        (result) => setLogs({ ...result, id: workload.id, name: workload.name }),
                      );
                    }}
                  >
                    {copy.logs}
                  </Button>
                  {workload.projectId && (
                    <Button asChild variant="secondary" size="sm">
                      <Link href={`/projects/${encodeURIComponent(workload.projectId)}`}>
                        {copy.openProject}
                      </Link>
                    </Button>
                  )}
                  {workload.manageable ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={
                          resource.busy ||
                          workload.state === "deploying" ||
                          workload.state === "unknown"
                        }
                        onClick={() =>
                          setConfirmation({
                            workload,
                            action: workload.state === "running" ? "stop" : "start",
                          })
                        }
                      >
                        {workload.state === "running" ? copy.stop : copy.start}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={resource.busy}
                        onClick={() => setConfirmation({ workload, action: "delete" })}
                      >
                        {copy.delete}
                      </Button>
                    </>
                  ) : (
                    <span className="self-center text-xs text-muted-foreground">
                      {copy.protected}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
          {resource.data.truncated && (
            <p className="text-sm text-muted-foreground">{copy.truncated}</p>
          )}
        </>
      )}
      {!resource.data && resource.busy && (
        <div className="h-32 animate-pulse rounded-xl bg-muted/40" />
      )}
    </ManagedControlPanel>
  );
}
