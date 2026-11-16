"use client";

import { useEffect, useRef, useState } from "react";
import {
  normalizeEdgePages,
  normalizeProjectEdgePages,
  type EdgePages,
  type ProjectEdgePages,
} from "@repo/core";
import type { ProjectEdgePagesStatus } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { projectsApi, getApiErrorMessage } from "@/lib/api";
import { systemApi } from "@/lib/api/system";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";
import { EdgePagesEditor, emptyEdgePages } from "./EdgePagesEditor";
import { EdgePagesSkeleton } from "./EdgePagesSkeleton";

type Props =
  | { serverId: string; projectId?: never; hostnames?: never; onSaved?: never }
  | {
      projectId: string;
      serverId?: never;
      hostnames: string[];
      onSaved?: (config: ProjectEdgePages) => void;
    };

export function EdgePagesPanel(props: Props) {
  return <Panel key={props.serverId ?? props.projectId} {...props} />;
}
function Panel({ serverId, projectId, hostnames, onSaved }: Props) {
  const { t } = useI18n();
  const w = t.widgets.routing.pages;
  const [project, setProject] = useState<ProjectEdgePages>({});
  const [server, setServer] = useState<EdgePages>(emptyEdgePages);
  const [scope, setScope] = useState("");
  const [state, setState] = useState<ProjectEdgePagesStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const load = serverId
      ? systemApi.getEdgePages(serverId).then((result) => {
          if (alive) setServer(result.config);
        })
      : projectsApi.getEdgePages(projectId!).then((result) => {
          if (alive) {
            setProject(result.config);
            setState(result);
          }
        });
    load
      .then(() => {
        if (alive) {
          setLoaded(true);
          setDirty(false);
        }
      })
      .catch((err) => {
        if (alive) setError(getApiErrorMessage(err, w.failed));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [serverId, projectId, refresh, w.failed]);
  const save = async () => {
    if (!loaded || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      if (serverId) {
        const result = await systemApi.updateEdgePages(
          serverId,
          normalizeEdgePages(server, "server"),
        );
        if (!mounted.current) return;
        setServer(result.config);
        setState({ config: {}, revision: "", status: "applied" });
      } else {
        const result = await projectsApi.updateEdgePages(
          projectId!,
          normalizeProjectEdgePages(project),
          state!.revision,
        );
        if (!mounted.current) return;
        setProject(result.config);
        setState(result);
        onSaved?.(result.config);
      }
      setDirty(false);
    } catch (err) {
      if (mounted.current) setError(getApiErrorMessage(err, w.failed));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const selected = serverId ? server : scope ? project.hosts?.[scope] : project.defaults;
  const change = (config: EdgePages) => {
    setDirty(true);
    if (serverId) setServer(config);
    else
      setProject((current) =>
        scope
          ? { ...current, hosts: { ...current.hosts, [scope]: config } }
          : { ...current, defaults: config },
      );
  };
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">{w.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {serverId ? w.serverHint : w.projectHint}
          </p>
        </div>
        <Button onClick={() => void save()} disabled={busy || loading || !loaded}>
          {busy ? w.saving : w.save}
        </Button>
      </div>
      {loading && !loaded ? (
        <EdgePagesSkeleton server={!!serverId} />
      ) : (
        <>
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              {w.loading}
            </p>
          )}
          {error && !loaded && (
            <ConnectionNotice
              role="alert"
              title={w.failed}
              message={error}
              onRetry={() => setRefresh((n) => n + 1)}
              retryLabel={w.retry}
            />
          )}
          {error && loaded && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-xl bg-danger-bg p-4 text-sm text-danger"
            >
              <p>{error}</p>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setRefresh((n) => n + 1)}
              >
                {dirty ? w.reloadSaved : w.retry}
              </Button>
            </div>
          )}
          {state && !dirty && !error && !busy && !loading && (
            <div
              role="status"
              className={`rounded-xl p-3 text-sm ${state.status === "pending" ? "bg-warning-bg text-warning" : "bg-muted/40 text-muted-foreground"}`}
            >
              {w[state.status]}
              {state.message && <p className="mt-1">{state.message}</p>}
            </div>
          )}
          {loaded && (
            <>
              {!serverId && (
                <div className="flex flex-wrap items-center gap-3">
                  <CustomSelect
                    aria-label={w.scope}
                    value={scope}
                    onChange={setScope}
                    disabled={busy || loading}
                    className="min-w-48 sm:max-w-sm"
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    options={[
                      { value: "", label: w.allDomains },
                      ...(hostnames ?? []).map((host) => ({ value: host, label: host })),
                    ]}
                  />
                  {scope && selected && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || loading}
                      onClick={() => {
                        const next = { ...project.hosts };
                        delete next[scope];
                        setProject({ ...project, hosts: next });
                        setDirty(true);
                      }}
                    >
                      {w.resetHost}
                    </Button>
                  )}
                </div>
              )}
              {scope && !selected ? (
                <div className="rounded-2xl bg-card p-5 space-y-4">
                  <p className="text-sm text-muted-foreground">{w.inheritHint}</p>
                  <Button
                    variant="secondary"
                    disabled={busy || loading}
                    onClick={() =>
                      change({
                        ...structuredClone(project.defaults ?? emptyEdgePages()),
                        maintenance: structuredClone(
                          project.defaults?.maintenance ?? { enabled: false, retryAfter: 300 },
                        ),
                      })
                    }
                  >
                    {w.customizeHost}
                  </Button>
                </div>
              ) : (
                <EdgePagesEditor
                  key={scope}
                  server={!!serverId}
                  value={selected ?? emptyEdgePages()}
                  inheritedMaintenance={scope ? project.defaults : undefined}
                  onChange={change}
                  disabled={busy || loading}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
