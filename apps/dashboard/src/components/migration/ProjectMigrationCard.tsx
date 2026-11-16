"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { SlidingToggle } from "@/components/ui/SlidingToggle";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi } from "@/lib/api/services";
import { dockerMigrationApi } from "@/lib/api/server-migration";
import {
  toggleMigrationService,
  validMigrationServiceScope,
  type MigrationServiceScope,
} from "./service-scope";

type Props = {
  projectId: string;
  projectName: string;
  sourceServerId: string;
  sourceServerName?: string | null;
  onStarted: (runId: string) => void;
  initialIntent?: "move" | "copy";
  initialServiceNames?: string[];
  copyOnly?: boolean;
};

/** Selection and review only. Progress/recovery use the shared migration session. */
export function ProjectMigrationCard(props: Props) {
  return <MigrationForm key={props.projectId} {...props} />;
}

function MigrationForm({
  projectId,
  projectName,
  sourceServerId,
  sourceServerName,
  onStarted,
  initialIntent = "move",
  initialServiceNames,
  copyOnly = false,
}: Props) {
  const { t } = useI18n();
  const mg = t.projectSettings.advanced.migration;
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const [target, setTarget] = useState<ServerOption | null>(null);
  const [intent, setIntent] = useState<"move" | "copy">(copyOnly ? "copy" : initialIntent);
  const [copyName, setCopyName] = useState(`${projectName}-copy`);
  const [services, setServices] = useState<Array<{
    name: string;
    volumes: number;
    dependencies: string[];
  }> | null>(null);
  const [scoped, setScoped] = useState<MigrationServiceScope>(() =>
    initialServiceNames ? new Set(initialServiceNames) : null,
  );
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [starting, setStarting] = useState(false);
  const submitting = useRef(false);
  const action = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setServices(null);
    setServicesError(null);
    void servicesApi
      .list(projectId)
      .then((res) => {
        if (cancelled) return;
        if (res.success === false) throw new Error(mg.servicesFailed);
        setServices(
          res.services
            .filter((svc) => svc.name)
            .map((svc) => ({
              name: svc.name,
              volumes: svc.volumes?.length ?? 0,
              dependencies: [
                ...new Set([
                  ...(svc.dependsOn ?? []),
                  ...Object.keys(svc.advanced?.dependsOnConditions ?? {}),
                  ...[svc.advanced?.networkMode, svc.advanced?.pidMode]
                    .filter((value): value is string => !!value?.startsWith("service:"))
                    .map((value) => value.slice(8)),
                ]),
              ],
            })),
        );
      })
      .catch((error) => {
        if (!cancelled) setServicesError(getApiErrorMessage(error, mg.servicesFailed));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision, mg.servicesFailed]);

  const scopeForRequest = useMemo(
    () => (intent === "copy" && scoped !== null ? [...scoped] : undefined),
    [intent, scoped],
  );
  const missingDependencies = useMemo(
    () => [
      ...new Set(
        (services ?? [])
          .filter((service) => scoped === null || scoped.has(service.name))
          .flatMap((service) => service.dependencies)
          .filter((name) =>
            scoped !== null
              ? !scoped.has(name)
              : !services?.some((service) => service.name === name),
          ),
      ),
    ],
    [services, scoped],
  );
  const scopeValid =
    services !== null &&
    validMigrationServiceScope(
      scoped,
      services.map((service) => service.name),
    ) &&
    !missingDependencies.length;
  const valid =
    !!target &&
    (intent === "copy"
      ? scopeValid && !servicesError && !!copyName.trim()
      : target.id !== sourceServerId);
  const busy = starting;

  const start = useCallback(async () => {
    // A ref closes the same-tick double-submit window before React renders.
    if (!mounted.current || !target || !valid || submitting.current) return;
    submitting.current = true;
    setStarting(true);
    try {
      const res = await dockerMigrationApi.startProjectMove({
        projectId,
        targetServerId: target.id,
        intent,
        serviceNames: scopeForRequest,
        ...(intent === "copy" && { newName: copyName.trim() }),
      });
      if (!res.migrationId) throw new Error(mg.startFailed);
      if (mounted.current) onStarted(res.migrationId);
    } catch (error) {
      if (mounted.current) showToast(getApiErrorMessage(error, mg.startFailed), "error", mg.title);
    } finally {
      submitting.current = false;
      if (mounted.current) setStarting(false);
    }
  }, [target, valid, projectId, intent, scopeForRequest, copyName, mg, onStarted, showToast]);

  const confirm = useCallback(() => {
    if (!target || !valid || submitting.current) return;
    const id = showModal({
      title: interpolate(intent === "move" ? mg.confirmTitle : mg.confirmTitleCopy, {
        project: projectName,
        server: target.name,
      }),
      message: [
        ...(intent === "copy"
          ? [copyName.trim(), ...(scopeForRequest ? [scopeForRequest.join(", ")] : [])]
          : []),
        mg.confirmSubtitle,
        intent === "move" ? mg.downtimeNote : mg.downtimeNoteCopy,
        intent === "move" ? mg.dnsNote : mg.copyNoDomainsNote,
      ].join(" · "),
      icon: "warning",
      maxWidth: "560px",
      onClose: () => requestAnimationFrame(() => action.current?.focus()),
      buttons: [
        { label: mg.cancel, variant: "secondary", onClick: () => hideModal(id) },
        {
          label: intent === "move" ? mg.confirmStart : mg.confirmStartCopy,
          variant: intent === "move" ? "danger" : "primary",
          onClick: () => void start(),
        },
      ],
    });
  }, [
    target,
    valid,
    intent,
    projectName,
    mg,
    showModal,
    hideModal,
    start,
    scopeForRequest,
    copyName,
  ]);

  return (
    <div className="@container/migration space-y-6">
      {!copyOnly && (
        <SlidingToggle
          value={intent}
          onChange={(value) => {
            if (busy) return;
            setIntent(value);
            if (value === "move" && target?.id === sourceServerId) setTarget(null);
          }}
          variant="square"
          size="md"
          backgroundColor="bg-muted/40"
          options={[
            { value: "move" as const, label: mg.intentMove },
            { value: "copy" as const, label: mg.intentCopy },
          ]}
        />
      )}
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {intent === "move" ? mg.intentMoveHint : mg.intentCopyHint}
      </p>
      <div className="grid gap-6 @3xl/migration:grid-cols-[1.15fr_1fr]">
        <section className="space-y-4 rounded-2xl bg-muted/25 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <UiIcon name="server" className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{mg.fromLabel}</p>
              <p className="truncate text-base font-medium">
                {sourceServerName || mg.currentServer}
              </p>
            </div>
            {services && (
              <span className="ms-auto text-sm tabular-nums text-muted-foreground">
                {interpolate(mg.sourceServices, { count: services.length })}
              </span>
            )}
          </div>
          {intent === "copy" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <h3 className="text-sm font-medium">{mg.scopeLabel}</h3>
                {scoped !== null && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setScoped(null)}>
                    {mg.scopeAll}
                  </Button>
                )}
              </div>
              {servicesError ? (
                <div role="alert" className="space-y-2 text-sm text-danger">
                  <p>{servicesError}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    {mg.retry}
                  </Button>
                </div>
              ) : services === null ? (
                <div
                  role="status"
                  className="flex items-center gap-2 py-5 text-sm text-muted-foreground"
                >
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                  {mg.loadingServices}
                </div>
              ) : services.length ? (
                <div className="grid gap-2 @lg/migration:grid-cols-2">
                  {services.map((service) => {
                    const checked = scoped === null || scoped.has(service.name);
                    return (
                      <button
                        key={service.name}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        disabled={busy}
                        onClick={() =>
                          setScoped((previous) =>
                            toggleMigrationService(
                              previous,
                              service.name,
                              services.map((item) => item.name),
                            ),
                          )
                        }
                        className={`flex min-h-14 items-center gap-3 rounded-xl px-4 py-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${checked ? "bg-background" : "hover:bg-background/60"}`}
                      >
                        <Checkbox checked={checked} asButton={false} />
                        <span className="min-w-0 flex-1 break-words text-sm font-medium">
                          {service.name}
                        </span>
                        {service.volumes > 0 && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {interpolate(mg.svcVolumes, { count: service.volumes })}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{mg.singleApplication}</p>
              )}
              <p className="text-sm leading-relaxed text-muted-foreground">
                {scoped === null
                  ? mg.scopeHintAll
                  : interpolate(mg.scopeHintSome, { count: scoped.size })}
              </p>
              {missingDependencies.length > 0 && (
                <p role="alert" className="text-sm text-warning">
                  {interpolate(mg.dependenciesRequired, {
                    services: missingDependencies.join(", "),
                  })}
                </p>
              )}
              {scoped !== null &&
                !validMigrationServiceScope(
                  scoped,
                  services?.map((service) => service.name) ?? null,
                ) &&
                services !== null && (
                  <p role="alert" className="text-sm text-danger">
                    {mg.selectService}
                  </p>
                )}
            </>
          )}
          {intent === "move" && (
            <p className="text-sm leading-relaxed text-muted-foreground">{mg.scopeHintAll}</p>
          )}
        </section>
        <section className="min-w-0 space-y-5 py-1">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{mg.toLabel}</h3>
            <ServerSelector
              compact
              forDeployment
              requiredCapability="exec"
              disabled={busy}
              value={target?.id ?? null}
              onSelect={setTarget}
              excludeIds={intent === "move" ? [sourceServerId] : []}
              emptyHint={intent === "move" ? mg.noOtherServers : undefined}
            />
          </div>
          {intent === "copy" && (
            <>
              <label className="block space-y-2 text-sm font-medium">
                <span>{mg.copyName}</span>
                <Input
                  variant="filled"
                  value={copyName}
                  disabled={busy}
                  maxLength={255}
                  onChange={(event) => setCopyName(event.target.value)}
                />
              </label>
              {target?.id === sourceServerId && (
                <p className="text-sm leading-relaxed text-muted-foreground">{mg.sameServerHint}</p>
              )}
              <div className="flex items-start gap-3 rounded-2xl bg-muted/25 p-4 text-sm leading-relaxed text-muted-foreground">
                <UiIcon name="copy" className="mt-0.5 size-4 shrink-0" />
                <p>{mg.copyNoDomainsNote}</p>
              </div>
            </>
          )}
          <p className="text-sm leading-relaxed text-muted-foreground">
            {intent === "copy" ? mg.downtimeNoteCopy : mg.downtimeNote}
          </p>
        </section>
      </div>
      <div className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{mg.cloudLater}</p>
        <Button
          ref={action}
          className="shrink-0 gap-2"
          size="lg"
          disabled={!valid || busy}
          onClick={confirm}
        >
          {busy && <UiIcon name="spinner" className="size-4 animate-spin" />}
          {intent === "move" ? mg.migrate : mg.duplicate}
          {!busy && <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />}
        </Button>
      </div>
    </div>
  );
}
