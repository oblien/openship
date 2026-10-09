"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { ActionRunnerConfig } from "@repo/core";
import type { ActionRunnerView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import ServerSelector from "@/components/shared/ServerSelector";
import { OptionCard } from "@/components/shared/OptionCard";
import { useI18n } from "@/components/i18n-provider";
import { ActionError } from "./ActionStatus";
import { ActionField } from "./ActionField";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

function Form({ runner }: { runner?: ActionRunnerView }) {
  const { t } = useI18n();
  const a = t.actions;
  const router = useRouter();
  const mutation = useActionMutation();
  const [serverId, setServerId] = useState<string | null>(runner?.serverId ?? null);
  const [name, setName] = useState(runner?.name ?? "");
  const [config, setConfig] = useState<ActionRunnerConfig>(
    runner?.config ?? {
      mode: "container",
      image: "catthehacker/ubuntu:act-22.04",
      labels: ["ubuntu-latest", "ubuntu-22.04"],
      maxParallel: 1,
      cpu: 1,
      memoryMb: 2048,
      allowDockerSocket: false,
    },
  );
  const [labels, setLabels] = useState(config.labels.join(", "));
  const [enabled, setEnabled] = useState(runner?.enabled ?? true);
  const cloud = runner?.kind === "cloud";
  const inspect = useCallback(
    () => (serverId ? actionsApi.inspectDestination(serverId) : Promise.resolve(null)),
    [serverId],
  );
  const capabilities = useActionResource(inspect);
  useEffect(() => {
    if (!runner && capabilities.data && !capabilities.data.docker) {
      setConfig((current) => ({ ...current, mode: "native" }));
      setLabels("");
    }
  }, [capabilities.data, runner]);
  const change = <K extends keyof ActionRunnerConfig>(key: K, value: ActionRunnerConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="@container space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!serverId || cloud) return;
        const result = await mutation.execute(() =>
          actionsApi.saveRunner(
            {
              serverId,
              name,
              enabled,
              config: {
                ...config,
                image: config.mode === "native" ? null : config.image,
                labels: labels
                  .split(",")
                  .map((label) => label.trim())
                  .filter(Boolean),
              },
            },
            runner?.id,
          ),
        );
        if (result) router.push("/actions");
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Button asChild size="sm" variant="ghost" className="mb-2 -ms-3">
            <Link href="/actions">
              <Icon name="arrow-left" className="rtl:rotate-180" />
              {a.back}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{runner?.name ?? a.newRunner}</h1>
        </div>
        <Button asChild variant="ghost">
          <Link href="/actions">{a.cancel}</Link>
        </Button>
      </header>
      <ActionError message={mutation.error} />
      <div className="grid items-start gap-5 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-5 rounded-2xl bg-card p-5">
          <ServerSelector
            value={serverId}
            onSelect={(server) => {
              setServerId(server?.id ?? null);
              if (!name && server) setName(server.name);
            }}
            forDeployment
            autoSelectFirst={false}
            label={a.server}
            disabled={!!runner || mutation.busy}
          />
          {serverId && (
            <>
              <ActionError message={capabilities.error} onRetry={capabilities.refresh} />
              <p className="text-xs text-muted-foreground" role="status">
                {capabilities.loading
                  ? a.checkingDestination
                  : capabilities.data
                    ? `${capabilities.data.os === "macos" ? "macOS" : "Linux"} · ${capabilities.data.architecture} · ${capabilities.data.docker ? a.dockerAvailable : a.nativeOnly}`
                    : ""}
              </p>
            </>
          )}
          <ActionField label={a.runnerName}>
            <Input
              variant="filled"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
            />
          </ActionField>
          <div>
            <h2 className="mb-3 text-sm font-semibold">{a.runnerMode}</h2>
            <div className="grid gap-3 @min-[700px]:grid-cols-2">
              {(["container", "native"] as const)
                .filter(
                  (mode) => mode !== "container" || !capabilities.data || capabilities.data.docker,
                )
                .map((mode) => (
                  <OptionCard
                    key={mode}
                    value={mode}
                    selected={config.mode === mode}
                    onSelect={() => {
                      change("mode", mode);
                      if (mode === "native") setLabels("");
                    }}
                    icon={
                      <Icon name={mode === "native" ? "terminal" : "docker"} className="size-4" />
                    }
                    label={a[mode]}
                    description={mode === "native" ? a.nativeHint : a.containerHint}
                  />
                ))}
            </div>
          </div>
          {config.mode === "container" && (
            <ActionField label={a.image}>
              <Input
                variant="filled"
                value={config.image ?? ""}
                onChange={(event) => change("image", event.target.value)}
                required
              />
            </ActionField>
          )}
          <ActionField label={a.labels} hint={a.labelsHint}>
            <Input
              variant="filled"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
            />
          </ActionField>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {config.mode === "container" && (
              <>
                <ActionField label={a.cpu}>
                  <Input
                    variant="filled"
                    type="number"
                    value={config.cpu}
                    min={0.25}
                    step={0.25}
                    max={128}
                    onChange={(event) => change("cpu", Number(event.target.value))}
                    required
                  />
                </ActionField>
                <ActionField label={a.memory}>
                  <Input
                    variant="filled"
                    type="number"
                    value={config.memoryMb}
                    min={256}
                    step={1}
                    max={524288}
                    onChange={(event) => change("memoryMb", Number(event.target.value))}
                    required
                  />
                </ActionField>
              </>
            )}
            <ActionField label={a.parallel}>
              <Input
                variant="filled"
                type="number"
                value={config.maxParallel}
                min={1}
                max={16}
                step={1}
                onChange={(event) => change("maxParallel", Number(event.target.value))}
                required
              />
            </ActionField>
          </div>
          {config.mode === "native" && (
            <p className="text-xs text-muted-foreground">{a.nativeLimits}</p>
          )}
        </section>
        <aside className="space-y-5 rounded-2xl bg-card p-5">
          <Icon name="server" className="size-6 text-muted-foreground" />
          <h2 className="text-base font-semibold">{a.destinations}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{a.trustedHint}</p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={setEnabled} />
            {a.enabled}
          </label>
          <Button
            type="submit"
            className="w-full"
            disabled={
              mutation.busy || !serverId || cloud || capabilities.loading || !!capabilities.error
            }
          >
            {mutation.busy ? a.saving : a.saveRunner}
          </Button>
        </aside>
      </div>
    </form>
  );
}

function Loader({ id }: { id?: string }) {
  const fetcher = useCallback(
    () =>
      id
        ? actionsApi.runners().then((runners) => {
            const runner = runners.find((runner) => runner.id === id);
            if (!runner) throw new Error("Runner not found");
            return { runner };
          })
        : Promise.resolve({ runner: undefined }),
    [id],
  );
  const resource = useActionResource<{ runner: ActionRunnerView | undefined }>(fetcher);
  return (
    <PageContainer>
      <ActionError message={resource.error} onRetry={resource.refresh} />
      {resource.data ? (
        <Form runner={resource.data.runner} />
      ) : resource.loading ? (
        <div className="h-72 animate-pulse rounded-2xl bg-card" />
      ) : null}
    </PageContainer>
  );
}
export function RunnerEditor({ id }: { id?: string }) {
  const scope = useActionScope();
  return <Loader key={`${scope}:${id ?? "new"}`} id={id} />;
}
