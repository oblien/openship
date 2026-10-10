"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import {
  actionRunnerArchitectures,
  actionRunnerLabels,
  actionRunnerMismatch,
  type ActionRunnerConfig,
} from "@repo/core";
import type { ActionRunnerView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import ServerSelector from "@/components/shared/ServerSelector";
import { useI18n } from "@/components/i18n-provider";
import { ActionError } from "./ActionStatus";
import { ActionField } from "./ActionField";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";
import {
  applyRunnerPreset,
  runnerPreset,
  runnerPresetName,
  RunnerCatalog,
  RunnerLogo,
  type RunnerPreset,
} from "./RunnerCatalog";

function Form({ runner }: { runner?: ActionRunnerView }) {
  const { t } = useI18n();
  const a = t.actions;
  const c = a.runnerSetup;
  const router = useRouter();
  const mutation = useActionMutation();
  const emulation = useActionMutation();
  const busy = mutation.busy || emulation.busy;
  const [serverId, setServerId] = useState<string | null>(runner?.serverId ?? null);
  const [name, setName] = useState(runner?.name ?? "");
  const [config, setConfig] = useState<ActionRunnerConfig>(
    () =>
      runner?.config ??
      applyRunnerPreset(
        {
          mode: "container",
          image: null,
          labels: [],
          maxParallel: 1,
          cpu: 1,
          memoryMb: 2048,
          allowDockerSocket: false,
        },
        "ubuntu",
      ),
  );
  const [labels, setLabels] = useState(config.labels.join(", "));
  const [enabled, setEnabled] = useState(runner?.enabled ?? true);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const cloud = runner?.kind === "cloud";
  const inspect = useCallback(
    () => (serverId ? actionsApi.inspectDestination(serverId) : Promise.resolve(null)),
    [serverId],
  );
  const capabilities = useActionResource(inspect);
  const configuredServer = useRef<string | null>(null);
  const suggestedName = useRef("");
  useEffect(() => {
    if (!runner && serverId && capabilities.data && configuredServer.current !== serverId) {
      configuredServer.current = serverId;
      const preset =
        capabilities.data.os === "macos" ? "macos" : capabilities.data.docker ? "ubuntu" : "linux";
      const next = applyRunnerPreset(config, preset);
      setConfig(next);
      setLabels(next.labels.join(", "));
    }
  }, [capabilities.data, runner, serverId, config]);
  const change = <K extends keyof ActionRunnerConfig>(key: K, value: ActionRunnerConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));
  const effectiveConfig = {
    ...config,
    image: config.mode === "native" ? null : config.image,
    labels: labels
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  };
  const mismatch = capabilities.data
    ? actionRunnerMismatch(capabilities.data, effectiveConfig, {
        labels: [],
        requiresDocker: false,
      })
    : null;
  const canSave =
    !!serverId &&
    !!capabilities.data &&
    !capabilities.loading &&
    !capabilities.error &&
    !mismatch &&
    (!!runner || configuredServer.current === serverId) &&
    !cloud &&
    !busy;
  const preset = runnerPreset(config, capabilities.data ?? runner?.capabilities ?? null);
  const matchingLabels = capabilities.data
    ? actionRunnerLabels(capabilities.data, effectiveConfig)
    : [];
  const choosePreset = (next: RunnerPreset) => {
    const updated = applyRunnerPreset(config, next);
    setConfig(updated);
    setLabels(updated.labels.join(", "));
    setCatalogOpen(false);
    if (next === "custom") setAdvanced(true);
  };
  return (
    <form
      className="@container space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canSave || !serverId) return;
        const result = await mutation.execute(() =>
          actionsApi.saveRunner({ serverId, name, enabled, config: effectiveConfig }, runner?.id),
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
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            {runner?.name ?? a.newRunner}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{c.subtitle}</p>
        </div>
        <Button asChild variant="ghost">
          <Link href="/actions">{a.cancel}</Link>
        </Button>
      </header>
      <ActionError message={mutation.error} />
      <ActionError message={emulation.error} />
      <div className="grid items-start gap-6 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
        <fieldset
          disabled={busy || cloud}
          className="m-0 min-w-0 space-y-5 rounded-2xl border-0 bg-card p-5"
        >
          <ServerSelector
            value={serverId}
            onSelect={(server) => {
              setServerId(server?.id ?? null);
              if (server?.id !== serverId) configuredServer.current = null;
              if (server) {
                if (!name || name === suggestedName.current) setName(server.name);
                suggestedName.current = server.name;
              }
            }}
            forDeployment
            autoSelectFirst={false}
            label={a.server}
            disabled={!!runner || busy || cloud}
          />
          {serverId && (
            <>
              <ActionError message={capabilities.error} onRetry={capabilities.refresh} />
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  {capabilities.loading ? (
                    <>
                      <Icon name="spinner" className="size-3.5 motion-safe:animate-spin" />
                      {a.checkingDestination}
                    </>
                  ) : capabilities.data ? (
                    <>
                      <Icon
                        name={capabilities.data.os === "macos" ? "apple" : "server"}
                        className="size-3.5"
                      />
                      {capabilities.data.os === "macos" ? "macOS" : "Linux"} ·{" "}
                      {capabilities.data.architecture} ·{" "}
                      {capabilities.data.docker ? a.dockerAvailable : a.nativeOnly}
                    </>
                  ) : null}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={a.probe}
                  title={a.probe}
                  onClick={capabilities.refresh}
                  disabled={capabilities.loading}
                >
                  <Icon name="refresh" />
                </Button>
              </div>
            </>
          )}
          <div className="space-y-3 border-t border-border/50 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">{c.environment}</h2>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setCatalogOpen(true)}
              >
                <Icon name="grid" />
                {c.browse}
              </Button>
            </div>
            <div className="flex items-center gap-4 rounded-xl bg-background/70 p-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-card">
                <RunnerLogo preset={preset} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">
                  {runnerPresetName(preset, c.presets)}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {c.presets[preset].hint}
                </p>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {serverId ? c.defaultImageHint : c.selectServer}
            </p>
            <ActionError
              message={config.mode === "container" && !config.image?.trim() ? null : mismatch}
            />
          </div>
          {config.mode === "container" && capabilities.data?.docker && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{c.architectures}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  {actionRunnerArchitectures(capabilities.data, config).map((architecture) => (
                    <span key={architecture} className="rounded-md bg-background px-2 py-1">
                      {architecture === "arm64" ? "ARM64" : "x64"}
                      {architecture !==
                      (capabilities.data!.dockerArchitecture ?? capabilities.data!.architecture)
                        ? ` · ${c.emulated}`
                        : ""}
                    </span>
                  ))}
                </div>
              </div>
              {actionRunnerArchitectures(capabilities.data, config).length < 2 && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      if (!serverId) return;
                      const result = await emulation.execute(() =>
                        actionsApi.enableEmulation(serverId),
                      );
                      if (result) capabilities.refresh();
                    }}
                  >
                    <Icon
                      name={emulation.busy ? "spinner" : "cpu"}
                      className={emulation.busy ? "motion-safe:animate-spin" : ""}
                    />
                    {emulation.busy ? c.enablingEmulation : c.enableEmulation}
                  </Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">{c.emulationHint}</p>
                </>
              )}
            </div>
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
          <details
            open={advanced}
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
            className="group border-t border-border/50 pt-4"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
              <span className="flex items-center gap-2">
                <Icon name="settings" className="size-4 text-muted-foreground" />
                {c.advanced}
              </span>
              <Icon
                name="chevron-down"
                className="size-4 text-muted-foreground group-open:rotate-180"
              />
            </summary>
            <div className="mt-5 space-y-5">
              {config.mode === "container" && (
                <ActionField label={a.image} hint={c.imageHint}>
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
              <div
                className={`grid gap-4 ${config.mode === "container" ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
              >
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
              {config.mode === "container" && (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={config.allowDockerSocket}
                    onCheckedChange={(value) => change("allowDockerSocket", value)}
                  />
                  <span>
                    <span className="block">{c.dockerAccess}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {c.dockerAccessHint}
                    </span>
                  </span>
                </label>
              )}
              {config.mode === "native" && (
                <p className="text-xs text-muted-foreground">{a.nativeLimits}</p>
              )}
            </div>
          </details>
        </fieldset>
        <aside className="space-y-5 rounded-2xl bg-card p-5">
          <div className="flex items-center gap-3">
            <Icon name="play-circle" className="size-6 text-info/80" />
            <div className="min-w-0">
              <h2 className="truncate text-base font-medium text-foreground">
                {name || a.newRunner}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{c.summary}</p>
            </div>
          </div>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{c.environment}</dt>
              <dd>{runnerPresetName(preset, c.presets)}</dd>
            </div>
            {config.mode === "container" && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{c.perJob}</dt>
                <dd className="tabular-nums">
                  {config.cpu} vCPU · {config.memoryMb / 1024} GiB
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{a.parallel}</dt>
              <dd className="tabular-nums">{config.maxParallel}</dd>
            </div>
          </dl>
          {matchingLabels.length > 0 && (
            <div className="space-y-2 border-t border-border/50 pt-4">
              <p className="text-xs text-muted-foreground">{c.matchHint}</p>
              <div className="flex flex-wrap gap-1.5" dir="ltr">
                {matchingLabels.map((label) => (
                  <code
                    className="rounded-md bg-background px-2 py-1 text-xs text-muted-foreground"
                    key={label}
                  >
                    {label}
                  </code>
                ))}
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={setEnabled} disabled={busy || cloud} />
            {c.acceptJobs}
          </label>
          <Button type="submit" className="w-full" disabled={!canSave}>
            {mutation.busy ? a.saving : a.saveRunner}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {config.mode === "native" ? c.trustedNative : c.trustedContainer}
          </p>
        </aside>
      </div>
      {catalogOpen && (
        <RunnerCatalog
          selected={preset}
          capabilities={capabilities.error || capabilities.loading ? null : capabilities.data}
          onSelect={choosePreset}
          onClose={() => setCatalogOpen(false)}
        />
      )}
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
