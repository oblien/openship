"use client";

import Link from "next/link";
import { useId } from "react";
import { Icon } from "@repo/ui/icons";
import { resolveGitHubDeploymentChecks, type GitHubDeploymentChecks } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Switch } from "@/components/ui/Switch";
import { Checkbox } from "@/components/ui/Checkbox";

/** The wizard and Project → Source edit the same saved reporting preferences. */
export function GitHubChecksSettings({ value, onChange, services = [], disabled, deliveryError }: {
  value?: GitHubDeploymentChecks | null;
  onChange: (value: GitHubDeploymentChecks) => void;
  services?: string[];
  disabled?: boolean;
  deliveryError?: string | null;
}) {
  const { t } = useI18n();
  const c = t.projectSettings.deploymentChecks;
  const id = useId();
  const config = resolveGitHubDeploymentChecks(value);
  const names = [...new Set([...services, ...(config.services === "all" ? [] : config.services)])];
  const change = (patch: Partial<GitHubDeploymentChecks>) => onChange({ ...config, ...patch });
  const row = (key: string, label: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <label key={key} htmlFor={`${id}-${key}`} className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
      <Checkbox id={`${id}-${key}`} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      {label}
    </label>
  );
  return (
    <section className="rounded-2xl bg-card p-5" aria-busy={disabled || undefined}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="github" className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.description}</p>
          </div>
        </div>
        <Switch checked={config.enabled} onChange={enabled => change({ enabled })} disabled={disabled} ariaLabel={c.title} />
      </div>
      {config.enabled && (
        <details className="group mt-4">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
            {c.customize}
            <Icon name="chevron-down" className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 space-y-4 rounded-xl bg-background/60 p-4">
            {row("deployment", c.deployment, config.deployment, deployment => change({ deployment }))}
            {row("services", c.services, config.services === "all", all => change({ services: all ? "all" : [] }))}
            {config.services !== "all" && names.length > 0 && (
              <div className="grid gap-2 ps-6 sm:grid-cols-2" role="group" aria-label={c.selectedServices}>
                {names.map((name, index) => row(`service-${index}`, name, config.services.includes(name), checked => {
                  const selected = config.services === "all" ? names : config.services;
                  change({ services: checked ? [...selected, name] : selected.filter(value => value !== name) });
                }))}
              </div>
            )}
            {row("errors", c.includeErrors, config.includeErrors, includeErrors => change({ includeErrors }))}
            <p className="text-xs leading-relaxed text-muted-foreground">{c.errorsHint}</p>
            {!config.deployment && config.services !== "all" && config.services.length === 0 && (
              <p className="text-xs text-warning" role="status">{c.emptySelection}</p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{c.connectionHint}</span>
              <Link href="/settings?tab=git" className="font-medium text-foreground underline underline-offset-4">{c.connection}</Link>
            </div>
          </div>
        </details>
      )}
      {config.enabled && deliveryError && (
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-warning-bg px-3 py-2.5 text-xs" role="status">
          <Icon name="info" className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">{c.deliveryFailed}</p>
            <p className="mt-1 break-words leading-relaxed text-muted-foreground">{deliveryError}</p>
          </div>
        </div>
      )}
    </section>
  );
}
