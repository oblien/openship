"use client";

import { reportCaughtError } from "@repo/core/diagnostics";
import { useEffect, useRef, useState } from "react";
import type { ProjectCompositeRoute } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { projectsApi, type Service } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Checkbox } from "@/components/ui/Checkbox";
import { servicePortTargets } from "@/lib/service-endpoints";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";

type Path = ProjectCompositeRoute["locations"][number];
type Domain = {
  id?: string;
  hostname?: string;
  domain?: string;
  redirectTo?: string | null;
  serviceId?: string | null;
};
type Props = {
  projectId: string;
  domains: Domain[];
  services: Service[];
  initial?: ProjectCompositeRoute[] | null;
  baseDomain: string;
  onSaved: (project: Record<string, unknown>) => void;
};

export function DomainPathsCard(props: Props) {
  const scope = useCloudResourceKey();
  return <DomainPathsEditor key={`${scope}:${props.projectId}`} {...props} />;
}

function DomainPathsEditor({ projectId, domains, services, initial, baseDomain, onSaved }: Props) {
  const { t } = useI18n();
  const copy = t.projectSettings.domainPaths;
  const available = domains.filter(
    (domain) => domain.id && (domain.hostname || domain.domain) && !domain.redirectTo,
  );
  const [selectedId, setSelectedId] = useState("");
  const selected = available.find((domain) => domain.id === selectedId) ?? available[0];
  const hostname = selected?.hostname ?? selected?.domain;
  const saved = initial?.find((route) => route.hostname === hostname);
  // Switching domains keeps each unsaved draft; saving submits only that domain.
  const [drafts, setDrafts] = useState<Record<string, Path[]>>({});
  const paths = selected?.id ? (drafts[selected.id] ?? saved?.locations ?? []) : [];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const portsFor = (service?: Service) =>
    service
      ? servicePortTargets(service, baseDomain)
          .filter((target) => target.port && target.protocol === "tcp")
          .map((target) => Number(target.port))
      : [];
  const targets = services.filter((service) => service.enabled && portsFor(service).length > 0);
  const rootId = selected?.serviceId ?? saved?.rootServiceId;
  const root = services.find((service) => service.id === rootId);
  const edit = (next: Path[]) => {
    if (!selected?.id) return;
    setDrafts((previous) => ({ ...previous, [selected.id!]: next }));
    setError(null);
    setNotice(null);
  };
  const patch = (index: number, update: Partial<Path>) =>
    edit(paths.map((path, at) => (at === index ? { ...path, ...update } : path)));
  const save = async () => {
    if (!selected?.id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await projectsApi.update(projectId, {
        domainRoutes: [{ domainId: selected.id, paths }],
      });
      if (!alive.current) return;
      const actual: Path[] =
        result.data?.compositeRoutes?.find(
          (route: ProjectCompositeRoute) => route.hostname === hostname,
        )?.locations ?? [];
      if (
        actual.length !== paths.length ||
        paths.some((path, index) => {
          const stored = actual[index];
          return (
            !stored ||
            stored.pathPrefix !== path.pathPrefix ||
            stored.serviceId !== path.serviceId ||
            Boolean(stored.exact) !== Boolean(path.exact) ||
            (path.port !== undefined && path.port !== stored.port)
          );
        })
      )
        throw new Error(copy.notApplied);
      invalidateProjectCaches(projectId);
      onSaved(result.data);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[selected.id!];
        return next;
      });
      setNotice(result.data?.routingWarning || copy.saved);
    } catch (failure) {
      reportCaughtError(failure, "dashboard/components/routing/DomainPathsCard");
      if (alive.current) setError(getApiErrorMessage(failure));
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  if (!available.length || services.length < 2) return null;
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={copy.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium text-foreground">{copy.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <Button onClick={save} disabled={saving || !selected}>
          {saving ? t.projectSettings.routing.saving : t.projectSettings.routing.save}
        </Button>
      </div>
      <CustomSelect
        aria-label={copy.domain}
        value={selected?.id ?? ""}
        onChange={(value) => {
          setSelectedId(value);
          setError(null);
          setNotice(null);
        }}
        disabled={saving}
        variant="filled"
        triggerClassName="bg-muted/60 hover:bg-muted"
        options={available.map((domain) => ({
          value: domain.id!,
          label: domain.hostname ?? domain.domain!,
        }))}
      />
      {root && <p className="text-sm text-muted-foreground">/ → {root.name}</p>}
      <div className="space-y-3">
        {paths.map((path, index) => (
          <div key={index} className="space-y-3 rounded-xl bg-card p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                aria-label={copy.path}
                value={path.pathPrefix}
                placeholder="/api"
                variant="filled"
                disabled={saving}
                onChange={(event) => patch(index, { pathPrefix: event.target.value })}
              />
              <CustomSelect
                aria-label={copy.service}
                value={path.serviceId}
                disabled={saving}
                variant="filled"
                triggerClassName="bg-muted/60 hover:bg-muted"
                placeholder={copy.service}
                options={targets.map((service) => ({ value: service.id, label: service.name }))}
                onChange={(serviceId) =>
                  patch(index, {
                    serviceId,
                    port: portsFor(services.find((service) => service.id === serviceId))[0],
                  })
                }
              />
              <CustomSelect
                aria-label={copy.port}
                value={String(path.port ?? "")}
                disabled={saving}
                variant="filled"
                triggerClassName="bg-muted/60 hover:bg-muted"
                placeholder={copy.port}
                options={portsFor(services.find((service) => service.id === path.serviceId)).map(
                  (port) => ({ value: String(port), label: String(port) }),
                )}
                onChange={(value) => patch(index, { port: Number(value) })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={Boolean(path.exact)}
                  disabled={saving}
                  onCheckedChange={(checked) => patch(index, { exact: checked })}
                />
                {copy.exact}
              </label>
              <Button
                variant="ghost"
                disabled={saving}
                aria-label={`${copy.remove} ${index + 1}`}
                onClick={() => edit(paths.filter((_, at) => at !== index))}
              >
                <Icon name="trash" className="size-4" />
                {copy.remove}
              </Button>
            </div>
          </div>
        ))}
        {!paths.length && <p className="text-sm text-muted-foreground">{copy.empty}</p>}
        <Button
          variant="secondary"
          disabled={saving || paths.length >= 100}
          onClick={() => {
            const service = targets.find((service) => service.id !== rootId) ?? targets[0];
            edit([
              ...paths,
              { pathPrefix: "", serviceId: service?.id ?? "", port: portsFor(service)[0] },
            ]);
          }}
        >
          <Icon name="plus" className="size-4" />
          {copy.add}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{copy.help}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
