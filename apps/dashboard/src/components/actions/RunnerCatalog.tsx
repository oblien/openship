"use client";

import { useId } from "react";
import type { ActionCapabilities, ActionRunnerConfig } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { AppLogo } from "@/components/AppLogo";
import { useI18n } from "@/components/i18n-provider";
import { OptionCard } from "@/components/shared/OptionCard";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

export const UBUNTU_RUNNER_IMAGE = "catthehacker/ubuntu:act-22.04";
export const RUNNER_PRESETS = ["ubuntu", "macos", "linux", "custom"] as const;
export type RunnerPreset = (typeof RUNNER_PRESETS)[number];

/** Versioned product names stay in the catalog, rather than prose dictionaries. */
export function runnerPresetName(
  preset: RunnerPreset,
  labels: Record<Exclude<RunnerPreset, "ubuntu">, { name: string }>,
): string {
  return preset === "ubuntu" ? "Ubuntu 22.04" : labels[preset].name;
}

/** Presets only populate the existing runner config; the server still verifies it. */
export function applyRunnerPreset(
  config: ActionRunnerConfig,
  preset: RunnerPreset,
): ActionRunnerConfig {
  const native = preset === "macos" || preset === "linux";
  return {
    ...config,
    mode: native ? "native" : "container",
    image: native ? null : preset === "ubuntu" ? UBUNTU_RUNNER_IMAGE : "",
    labels: preset === "ubuntu" ? ["ubuntu-latest", "ubuntu-22.04"] : [],
  };
}

export function runnerPreset(
  config: ActionRunnerConfig,
  capabilities: ActionCapabilities | null,
): RunnerPreset {
  return config.mode === "native"
    ? capabilities?.os === "macos"
      ? "macos"
      : "linux"
    : config.image === UBUNTU_RUNNER_IMAGE
      ? "ubuntu"
      : "custom";
}

export function RunnerLogo({
  preset,
  className = "size-7",
}: {
  preset: RunnerPreset;
  className?: string;
}) {
  if (preset === "ubuntu") return <AppLogo slug="ubuntu" icon="docker" className={className} />;
  if (preset === "linux")
    return (
      <AppLogo
        slug="linux/000000"
        icon="server"
        className={`${className} dark:invert dim:invert`}
      />
    );
  return <Icon name={preset === "macos" ? "apple" : "docker"} className={className} />;
}

export function RunnerCatalog({
  selected,
  capabilities,
  onSelect,
  onClose,
}: {
  selected: RunnerPreset;
  capabilities: ActionCapabilities | null;
  onSelect: (preset: RunnerPreset) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const c = t.actions.runnerSetup;
  const id = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const unavailable = (preset: RunnerPreset) => {
    if (!capabilities) return c.selectServer;
    if (preset === "macos" && capabilities.os !== "macos") return c.needsMac;
    if (preset === "linux" && capabilities.os !== "linux") return c.needsLinux;
    if ((preset === "ubuntu" || preset === "custom") && !capabilities.docker) return c.needsDocker;
    return null;
  };
  return (
    <Modal isOpen onClose={onClose} showCloseButton={false} width="720px" maxWidth="95vw">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-5 p-5 outline-none sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-medium text-foreground" id={id}>
              {c.catalog}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.catalogHint}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label={t.actions.cancel} onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {RUNNER_PRESETS.map((preset) => {
            const reason = unavailable(preset);
            return (
              <OptionCard
                key={preset}
                value={preset}
                selected={selected === preset}
                disabled={!!reason}
                onSelect={() => onSelect(preset)}
                icon={<RunnerLogo preset={preset} />}
                label={runnerPresetName(preset, c.presets)}
                description={
                  <span className="block space-y-3">
                    <span className="block">{c.presets[preset].hint}</span>
                    <span
                      className={`block text-xs ${reason ? "text-muted-foreground" : "text-foreground/80"}`}
                    >
                      {reason ??
                        (preset === "macos" || preset === "linux"
                          ? t.actions.native
                          : t.actions.container)}
                    </span>
                  </span>
                }
              />
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
