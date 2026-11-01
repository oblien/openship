"use client";

import type { ActionRunnerView } from "@repo/contracts";
import { actionRunnerArchitectures } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { RunnerLogo } from "./RunnerCatalog";

type Runner = Pick<ActionRunnerView, "capabilities" | "config" | "labels" | "kind">;

/** Describe the execution environment, never infer capabilities from routing labels. */
export function RunnerIdentity({ runner }: { runner: Runner }) {
  const os = runner.config.mode === "container" ? "linux" : runner.capabilities?.os;
  return (
    <span
      className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/70 text-muted-foreground"
      aria-hidden="true"
    >
      {os && runner.capabilities ? (
        <RunnerLogo preset={os === "macos" ? "macos" : "linux"} className="size-6" />
      ) : (
        <Icon name={runner.kind === "cloud" ? "cloud" : "server"} className="size-5" />
      )}
      {runner.kind === "cloud" && runner.capabilities && (
        <span className="absolute -bottom-1 -end-1 rounded-full bg-card p-0.5">
          <Icon name="cloud" className="size-3" />
        </span>
      )}
    </span>
  );
}

export function RunnerCapabilities({
  runner,
  compact = false,
}: {
  runner: Runner;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const a = t.actions;
  const { capabilities, config } = runner;
  if (!capabilities)
    return <span className="text-xs text-muted-foreground">{a.runnerDetails.unchecked}</span>;

  const container = config.mode === "container";
  if (container && !capabilities.docker)
    return <span className="text-xs text-muted-foreground">{a.runnerSetup.needsDocker}</span>;
  const os = container || capabilities.os === "linux" ? "Linux" : "macOS";
  const native = container
    ? (capabilities.dockerArchitecture ?? capabilities.architecture)
    : capabilities.architecture;
  const architectures = actionRunnerArchitectures(capabilities, config);
  return (
    <span
      className={`flex flex-wrap items-center text-xs ${compact ? "gap-x-1.5 gap-y-1 text-muted-foreground" : "gap-2"}`}
    >
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span>{os}</span>
        <span aria-hidden="true">·</span>
        {container && <Icon name="docker" className="size-3.5" aria-hidden="true" />}
        <span>{container ? "Docker" : a.native}</span>
      </span>
      {architectures.map((architecture) => (
        <span
          key={architecture}
          className={
            compact
              ? "inline-flex items-center gap-1.5"
              : "rounded-md bg-muted/60 px-2 py-1 text-muted-foreground"
          }
        >
          {compact && <span aria-hidden="true">·</span>}
          <span>
            <bdi>{architecture === "arm64" ? "ARM64" : "x64"}</bdi>
            {architecture !== native
              ? ` · ${a.runnerSetup.emulated}`
              : !compact
                ? ` · ${a.native}`
                : ""}
          </span>
        </span>
      ))}
    </span>
  );
}

export function RunnerDetails({ runner }: { runner: Runner }) {
  const { t, locale } = useI18n();
  const a = t.actions;
  const { config, capabilities } = runner;
  const container = config.mode === "container";
  const host = capabilities?.os === "macos" ? "macOS" : capabilities?.distribution || "Linux";
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return (
    <details className="group/runner min-w-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        {a.runnerDetails.details}
        <Icon
          name="chevron-down"
          className="size-3.5 shrink-0 transition-transform group-open/runner:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-4 pb-1 pt-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs">
          {capabilities && (
            <>
              <dt className="text-muted-foreground">{a.runnerDetails.host}</dt>
              <dd className="min-w-0 text-end">
                <bdi>
                  <span className="capitalize">{host}</span>
                  {capabilities.version ? ` ${capabilities.version}` : ""} ·{" "}
                  {capabilities.architecture === "arm64" ? "ARM64" : "x64"}
                </bdi>
              </dd>
            </>
          )}
          {container && config.image && (
            <>
              <dt className="text-muted-foreground">{a.runnerDetails.defaultImage}</dt>
              <dd className="min-w-0 text-end">
                <code dir="ltr" className="break-all">
                  {config.image}
                </code>
              </dd>
            </>
          )}
          {container && (
            <>
              <dt className="text-muted-foreground">{a.runnerSetup.perJob}</dt>
              <dd className="min-w-0 text-end tabular-nums">
                <bdi>
                  {number.format(config.cpu)} vCPU · {number.format(config.memoryMb / 1024)} GiB
                </bdi>
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{a.parallel}</dt>
          <dd className="text-end tabular-nums">{number.format(config.maxParallel)}</dd>
        </dl>
        {container && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {a.runnerDetails.imageHint}
          </p>
        )}
        {runner.labels.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">{a.editor.runsOn}</p>
            <div className="flex flex-wrap gap-1.5">
              {runner.labels.map((label) => (
                <code
                  key={label}
                  dir="ltr"
                  className="max-w-full break-all rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground"
                >
                  {label}
                </code>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {a.runnerDetails.labelsHint}
            </p>
          </div>
        )}
      </div>
    </details>
  );
}
