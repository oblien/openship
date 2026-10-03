"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { usePlatform } from "@/context/PlatformContext";
import { getPublicEndpointHosts, getRecommendedSingleAppBuildImage, workloadOf, type PublicEndpoint } from "@/context/deployment/types";
import type { WorkloadType } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface InputField {
  key: string;
  label: React.ReactNode;
  placeholder: string;
  description: string;
  type: 'text' | 'number';
  min?: number;
  max?: number;
  optional?: boolean;
  icon: React.ReactNode;
  source?: 'options' | 'config';
}

interface BuildSettingsProps {
  variant?: 'deploy' | 'import';
  mode?: 'simple' | 'advanced';
  buildData?: any;
  onSave?: (field: string, value: string) => Promise<void>;
  loading?: { [key: string]: boolean };
  buildConfig?: any;
  updateOptions?: (options: any) => void;
}

const BuildSettings: React.FC<BuildSettingsProps> = ({
  mode = 'simple',
  buildData: externalBuildData,
  onSave,
  loading = {},
  buildConfig,
  updateOptions: externalUpdateOptions
}) => {
  const deploymentContext = useOptionalDeployment();
  const fallbackContext = { config: buildConfig || {}, updateOptions: externalUpdateOptions || (() => {}), updateConfig: () => {} };
  const resolvedContext = mode === 'simple'
    ? (deploymentContext ?? fallbackContext)
    : fallbackContext;
  const { config, updateOptions, updateConfig } = resolvedContext;
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const bs = t.importProject.buildSettings;

  const fieldPrefix = useId();

  const [editingField, setEditingField] = useState<string | null>(null);
  const [tempValues, setTempValues] = useState<{ [key: string]: string }>({});
  const [expanded, setExpanded] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const buildData = mode === 'advanced' ? externalBuildData : config?.options;
  const needsBuild = config?.framework !== "node" && config?.framework !== "static";

  const hasBuild = buildData?.hasBuild !== false;
  const hasServer = !!buildData?.hasServer;
  // The runtime workload (#538): a worker runs a process like a server but binds
  // no port and gets no route, so it needs the Start command yet none of the
  // port/endpoint UI. Selecting it syncs the legacy hasServer boolean (web only).
  const workload = workloadOf(buildData ?? {});
  const setWorkload = (w: WorkloadType) =>
    updateOptions?.({ workloadType: w, hasServer: w === "web" });
  const workloadOptions: { value: WorkloadType; label: string }[] = [
    { value: "web", label: bs.modeServer },
    { value: "worker", label: bs.modeWorker },
    { value: "static", label: bs.modeStatic },
  ];
  // Only a host the config actually names. The old fallback labelled the port
  // field "Port for <projectName>.<baseDomain>" for a config with no chosen
  // route at all — a hostname nobody created.
  const primaryEndpointHost = getPublicEndpointHosts(config?.publicEndpoints, baseDomain)[0] ?? "";
  const additionalServerEndpoints: PublicEndpoint[] = hasServer
    ? (config?.publicEndpoints ?? []).slice(1)
    : [];
  const staticEndpoints: PublicEndpoint[] = hasServer
    ? []
    : (config?.publicEndpoints ?? []);
  const recommendedBuildImage = getRecommendedSingleAppBuildImage({
    framework: config?.framework || "unknown",
    packageManager: config?.packageManager || "npm",
    buildImage: config?.buildImage || "",
  });
  const primaryPortLabel = primaryEndpointHost
    ? (
      <>
        {bs.portForPrefix} <span className="text-foreground font-semibold">{primaryEndpointHost}</span>
      </>
    )
    : bs.productionPort;

  // ── Build-group fields (shown when Build is ON) ──────────────────
  const buildFields: InputField[] = [
    {
      key: 'installCommand',
      label: bs.installCommandLabel,
      placeholder: 'bun install',
      description: bs.installCommandDesc,
      type: 'text',
      icon: <UiIcon name="terminal" className="size-4" />
    },
    ...(needsBuild ? [
      {
        key: 'buildCommand',
        label: bs.buildCommandLabel,
        placeholder: 'npm run build',
        description: bs.buildCommandDesc,
        type: 'text' as const,
        icon: <UiIcon name="terminal" className="size-4" />
      },
      {
        key: 'outputDirectory',
        label: bs.outputDirectoryLabel,
        placeholder: '.next',
        description: bs.outputDirectoryDesc,
        type: 'text' as const,
        icon: <UiIcon name="folder-out" className="size-4" />
      },
    ] : []),
  ];

  // ── Advanced fields (hidden behind toggle) ───────────────────────
  const advancedFields: InputField[] = [
    {
      key: 'rootDirectory',
      label: bs.sourceFolderLabel,
      placeholder: './',
      description: bs.sourceFolderDesc,
      type: 'text',
      optional: true,
      icon: <UiIcon name="folder-out" className="size-4" />
    },
    {
      key: 'buildImage',
      label: bs.buildImageLabel,
      placeholder: recommendedBuildImage,
      description: bs.buildImageDesc,
      type: 'text',
      optional: true,
      icon: <UiIcon name="select" className="size-4" />,
      source: 'config',
    },
    ...(needsBuild ? [
      {
        key: 'productionPaths',
        label: bs.productionPathsLabel,
        placeholder: 'dist, node_modules, package.json',
        description: bs.productionPathsDesc,
        type: 'text' as const,
        optional: true,
        icon: <UiIcon name="shield-check" className="size-4" />
      },
    ] : []),
  ];

  // ── Start-group fields (shown when Start is ON) ──────────────────
  const startFields: InputField[] = [
    {
      key: 'startCommand',
      label: bs.startCommandLabel,
      placeholder: 'npm start',
      description: bs.startCommandDesc,
      type: 'text',
      icon: <UiIcon name="play" className="size-4" />
    },
    {
      key: 'productionPort',
      label: primaryPortLabel,
      placeholder: bs.enterPort,
      description: bs.productionPortDesc,
      type: 'number',
      min: 1,
      max: 65535,
      optional: true,
      icon: <UiIcon name="hash" className="size-4" />
    },
  ];

  // ── General fields (always visible) ──────────────────────────────
  const generalFields: InputField[] = [];

  const handleEdit = (field: string, currentValue: string) => {
    setEditingField(field);
    setTempValues({ ...tempValues, [field]: currentValue || '' });
  };

  const handleSave = async (field: string) => {
    if (mode === 'advanced' && onSave) {
      await onSave(field, tempValues[field]);
      setEditingField(null);
    }
  };

  const handleCancel = (field: string, originalValue: string) => {
    setEditingField(null);
    setTempValues({ ...tempValues, [field]: originalValue });
  };

  const handleChange = (field: InputField, value: string) => {
    if (mode === 'simple' && updateOptions) {
      if (field.key === 'productionPort' && config?.options?.hasServer && updateConfig) {
        const [primaryEndpoint, ...remainingEndpoints] = config.publicEndpoints || [];
        updateConfig({
          productionPortTouched: true,
          lastAutoDetectedEnvPort: null,
          options: {
            ...config.options,
            productionPort: value,
          },
          publicEndpoints: primaryEndpoint
            ? [{
                ...primaryEndpoint,
                port: value,
              }, ...remainingEndpoints]
            : config.publicEndpoints,
        } as any);
        return;
      }

      if (field.source === 'config' && updateConfig) {
        updateConfig({ [field.key]: value } as any);
        return;
      }

      updateOptions({ [field.key]: value } as any);
    } else {
      setTempValues({ ...tempValues, [field.key]: value });
    }
  };

  const renderInput = (field: InputField) => {
    const value = mode === 'simple'
      ? field.source === 'config'
        ? (config as any)?.[field.key]
        : (config?.options as any)?.[field.key]
      : field.source === 'config'
        ? (config as any)?.[field.key]
        : buildData?.[field.key];
    const isCurrentlyEditing = mode === 'advanced' && editingField === field.key;
    const displayValue = isCurrentlyEditing ? tempValues[field.key] : value;

    if (mode === 'simple') {
      return (
        <div key={field.key}>
          <label htmlFor={`${fieldPrefix}-${field.key}`} className="text-sm font-medium text-foreground mb-1.5 block">
            {field.label}
            {field.optional && (
              <span className="text-xs text-muted-foreground ms-1">{bs.optional}</span>
            )}
          </label>
          <Input
            dir="ltr"
            id={`${fieldPrefix}-${field.key}`}
            variant="filled"
            type={field.type}
            min={field.min}
            max={field.max}
            value={displayValue || ''}
            onChange={(e) => handleChange(field, e.target.value)}
            placeholder={field.placeholder}
            className={field.type === 'text' ? "min-w-0 font-mono" : "min-w-0"}
          />
        </div>
      );
    }

    // Advanced mode
    return (
      <div key={field.key}>
        <div className="mb-3">
          <h3 className="text-sm font-medium text-foreground">{field.label}</h3>
          <p className="text-xs text-muted-foreground mt-1">{field.description}</p>
        </div>

        {isCurrentlyEditing ? (
          <div className="space-y-3">
            <div className="relative">
              <span className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">{field.icon}</span>
              <Input
                dir="ltr"
                variant="filled"
                aria-label={typeof field.label === 'string' ? field.label : undefined}
                type={field.type}
                min={field.min}
                max={field.max}
                value={displayValue || ''}
                onChange={(e) => setTempValues({ ...tempValues, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                className="min-w-0 ps-10 font-mono"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => handleSave(field.key)}
                disabled={loading[field.key]}
              >
                {bs.save}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => handleCancel(field.key, value)}
              >
                {bs.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="relative p-3 bg-background rounded-xl group">
            <div className="flex items-center gap-3">
              {field.icon}
              <p className="min-w-0 flex-1 truncate pe-8 font-mono text-sm text-foreground">{displayValue || field.placeholder}</p>
            </div>
            <button
              onClick={() => handleEdit(field.key, value)}
              className="absolute end-3 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground/50 hover:text-primary transition-colors"
            >
              <UiIcon name="edit" className="size-4" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const visibleBuildFields = hasBuild ? buildFields : [];
  // web → start command + port; worker → start command only (no port); static → none.
  const visibleStartFields =
    workload === "web"
      ? startFields
      : workload === "worker"
        ? startFields.filter((f) => f.key !== "productionPort")
        : [];

  /** Label for one endpoint's port/path field: its host when the config names
   *  one, else a positional "domain N" — never a composed guess. */
  const resolveEndpointHost = (endpoint: PublicEndpoint, index: number) => {
    if (endpoint.domainType === 'custom' && endpoint.customDomain) {
      return endpoint.customDomain;
    }

    if (endpoint.domain) {
      return `${endpoint.domain}.${baseDomain}`;
    }

    if (index === 0 && primaryEndpointHost) {
      return primaryEndpointHost;
    }

    return `domain ${index + 1}`;
  };

  const handleAdditionalEndpointPortChange = (endpointId: string, value: string) => {
    if (!updateConfig || !config) return;

    updateConfig({
      publicEndpoints: (config.publicEndpoints || []).map((endpoint: PublicEndpoint) => (
        endpoint.id === endpointId
          ? {
              ...endpoint,
              port: value,
            }
          : endpoint
      )),
    } as any);
  };

  const handleEndpointTargetPathChange = (endpointId: string, value: string) => {
    if (!updateConfig || !config) return;

    updateConfig({
      publicEndpoints: (config.publicEndpoints || []).map((endpoint: PublicEndpoint) => (
        endpoint.id === endpointId
          ? {
              ...endpoint,
              targetPath: value,
            }
          : endpoint
      )),
    } as any);
  };

  const renderEndpointTargetInputs = () => {
    if (mode !== 'simple') {
      return null;
    }

    if (hasServer) {
      if (additionalServerEndpoints.length === 0) {
        return null;
      }

      return additionalServerEndpoints.map((endpoint: PublicEndpoint, index: number) => {
        const hostname = resolveEndpointHost(endpoint, index + 1);

        return (
          <div key={endpoint.id}>
            <label htmlFor={`${fieldPrefix}-port-${endpoint.id}`} className="text-sm font-medium text-foreground mb-1.5 block">
              {bs.portForPrefix} <span className="text-foreground font-semibold">{hostname}</span>
              <span className="text-xs text-muted-foreground ms-1">{bs.optional}</span>
            </label>
            <Input
              dir="ltr"
              id={`${fieldPrefix}-port-${endpoint.id}`}
              variant="filled"
              type="number"
              min={1}
              max={65535}
              value={endpoint.port || ''}
              onChange={(event) => handleAdditionalEndpointPortChange(endpoint.id, event.target.value)}
              placeholder={config?.options?.productionPort || bs.enterPort}
            />
          </div>
        );
      });
    }

    if (staticEndpoints.length === 0) {
      return null;
    }

    return staticEndpoints.map((endpoint: PublicEndpoint, index: number) => {
      const hostname = resolveEndpointHost(endpoint, index);

      return (
        <div key={endpoint.id}>
          <label htmlFor={`${fieldPrefix}-path-${endpoint.id}`} className="text-sm font-medium text-foreground mb-1.5 block">
            {bs.pathForPrefix} <span className="text-foreground font-semibold">{hostname}</span>
          </label>
          <Input
            dir="ltr"
            id={`${fieldPrefix}-path-${endpoint.id}`}
            variant="filled"
            type="text"
            value={endpoint.targetPath || '/'}
            onChange={(event) => handleEndpointTargetPathChange(endpoint.id, event.target.value)}
            placeholder="/"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{bs.staticPathHint}</p>
        </div>
      );
    });
  };

  if (mode === 'simple') {
    return (
      <div className="@container/build-settings bg-card rounded-2xl">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between gap-3 rounded-2xl px-5 py-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <div className="flex items-center gap-3">
            <div className="size-9 shrink-0 rounded-xl bg-warning-bg flex items-center justify-center">
              <UiIcon name="sliders" className="size-[18px] text-warning" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{bs.deployConfig}</p>
              <p className="text-xs text-muted-foreground">
                {config?.framework ? interpolate(bs.defaultsApplied, { framework: config.framework }) : bs.configureOptions}
              </p>
            </div>
          </div>
          {expanded ? (
            <UiIcon name="chevron-up" className="size-4 text-muted-foreground" />
          ) : (
            <UiIcon name="chevron-down" className="size-4 text-muted-foreground" />
          )}
        </button>

        {expanded && (
          <div className="space-y-5 px-5 pb-5 border-t border-border/50 pt-4">
            <div className="grid @min-[40rem]/build-settings:grid-cols-2 gap-5">
              {/* ── Build column ──────────────────────────────── */}
              <div className="flex min-h-12 min-w-0 items-center justify-between gap-3 rounded-xl bg-card px-3 py-2">
                <div className="flex items-center gap-2">
                  <UiIcon name="wrench" className="size-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">{bs.build}</p>
                </div>
                <Toggle aria-label={bs.build} checked={hasBuild} onChange={(v: boolean) => updateOptions?.({ hasBuild: v })} />
              </div>
              <div className="min-w-0 space-y-4 empty:hidden @min-[40rem]/build-settings:col-start-1 @min-[40rem]/build-settings:row-start-2">
                {visibleBuildFields.map(renderInput)}
                {generalFields.map(renderInput)}
              </div>

              {/* ── Start column (Server / Worker / Static, #538) ── */}
              <div className="flex min-h-12 min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 @min-[40rem]/build-settings:col-start-2 @min-[40rem]/build-settings:row-start-1">
                <div className="flex shrink-0 items-center gap-2">
                  <UiIcon name="play" className="size-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">{bs.start}</p>
                </div>
                <div role="group" aria-label={bs.start} className="grid grid-cols-3 gap-1">
                  {workloadOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setWorkload(opt.value)}
                      aria-pressed={workload === opt.value}
                      className={`px-2 py-1.5 text-sm font-medium rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                        workload === opt.value
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-0 space-y-4 empty:hidden @min-[40rem]/build-settings:col-start-2 @min-[40rem]/build-settings:row-start-2">
                {visibleStartFields.map(renderInput)}
                {renderEndpointTargetInputs()}
              </div>
            </div>

            {/* ── Advanced (collapsible) ──────────────────── */}
            {advancedFields.length > 0 && (
              <div>
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  className="w-full flex items-center justify-between gap-2 rounded-xl bg-card px-3 py-3 text-start hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <UiIcon name="shield-check" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-sm font-medium text-foreground">{bs.advanced}</span>
                    {(config?.releaseCommands?.length ?? 0) > 0 && (
                      <span className="truncate rounded-md bg-background px-2 py-0.5 text-xs text-foreground" title={bs.releaseTitle}>
                        {bs.releaseTitle} · {config.releaseCommands.length}
                      </span>
                    )}
                  </div>
                  {advancedOpen ? (
                    <UiIcon name="chevron-up" className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <UiIcon name="chevron-down" className="size-3 shrink-0 text-muted-foreground" />
                  )}
                </button>
                {advancedOpen && (
                  <div className="grid gap-5 pt-4 @min-[40rem]/build-settings:grid-cols-2">
                    {advancedFields.map(renderInput)}
                    {(workload !== "static" || config?.releaseCommands?.length > 0) && (
                      <div className="space-y-2 @min-[40rem]/build-settings:col-span-2">
                        <p className="text-sm font-medium text-foreground">{bs.releaseTitle}</p>
                        <p className="text-xs text-muted-foreground">{bs.releaseDescription}</p>
                        {(config?.releaseCommands ?? []).map((command: string, index: number) => (
                          <div key={index} className="flex items-start gap-2">
                            <Textarea
                              dir="ltr"
                              variant="filled"
                              aria-label={interpolate(bs.releaseCommand, { number: String(index + 1) })}
                              rows={1}
                              maxLength={1000}
                              value={command}
                              spellCheck={false}
                              onChange={(event) => updateConfig({
                                releaseCommands: config.releaseCommands.map((value: string, at: number) =>
                                  at === index ? event.target.value : value),
                              })}
                              className="min-w-0 flex-1 font-mono"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              type="button"
                              aria-label={interpolate(bs.removeReleaseCommand, { number: String(index + 1) })}
                              onClick={() => updateConfig({
                                releaseCommands: config.releaseCommands.filter((_: string, at: number) => at !== index),
                              })}
                              className="shrink-0"
                            >
                              <UiIcon name="close" className="size-4" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={(config?.releaseCommands?.length ?? 0) >= 20}
                          onClick={() => updateConfig({ releaseCommands: [...(config?.releaseCommands ?? []), ""] })}
                        >
                          <UiIcon name="plus" className="size-3.5" />
                          {bs.addReleaseCommand}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Advanced mode
  const allVisibleFields = [...visibleBuildFields, ...visibleStartFields, ...generalFields];
  return (
    <div className="bg-card rounded-2xl p-5">
      <h2 className="text-lg font-semibold text-foreground mb-6">
        {bs.buildSettingsTitle}
      </h2>
      <div className="grid gap-5 mb-6">
        <div className="grid md:grid-cols-2 gap-5">
          {allVisibleFields.map(renderInput)}
        </div>
      </div>

      {/* ── Advanced section ──────────────────────────── */}
      {advancedFields.length > 0 && (
        <div className="border-t border-border/50 pt-4">
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center gap-2 mb-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <UiIcon name="shield-check" className="size-4" />
            <span className="font-medium">{bs.advanced}</span>
            {advancedOpen ? <UiIcon name="chevron-up" className="size-3.5" /> : <UiIcon name="chevron-down" className="size-3.5" />}
          </button>
          {advancedOpen && (
            <div className="grid md:grid-cols-2 gap-5">
              {advancedFields.map(renderInput)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(BuildSettings);
