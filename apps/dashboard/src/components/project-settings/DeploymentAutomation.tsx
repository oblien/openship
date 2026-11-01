"use client";
import { useEffect, useState } from "react";
import type { ProjectControlOperations } from "@repo/contracts";
import { api, getApiRequestScopeVersion } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";

type Previews = Awaited<ReturnType<ProjectControlOperations["listPreviews"]>>;
type Caches = Awaited<ReturnType<ProjectControlOperations["buildCacheMigration"]>>;

export function PullRequestPreviews({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Previews | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [comments, setComments] = useState(true);
  const [baseDomain, setBaseDomain] = useState("");
  const [protectionHostname, setProtectionHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    let initialized = false;
    const scope = getApiRequestScopeVersion();
    setData(null);
    setError("");
    const refresh = async () => {
      try {
        const result = await api.get<{ data: Previews }>(
          `projects/${encodeURIComponent(projectId)}/previews`,
        );
        if (!live || scope !== getApiRequestScopeVersion()) return;
        setData(result.data);
        if (!initialized) {
          setEnabled(result.data.settings?.enabled ?? false);
          setComments(result.data.settings?.comments ?? true);
          setBaseDomain(result.data.settings?.baseDomain ?? "");
          setProtectionHostname(result.data.settings?.protectionHostname ?? "");
          initialized = true;
        }
      } catch (cause) {
        if (live && scope === getApiRequestScopeVersion())
          setError(getApiErrorMessage(cause, "Could not load pull request previews."));
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId]);
  const save = async () => {
    const scope = getApiRequestScopeVersion();
    setBusy(true);
    setError("");
    try {
      await api.post(`projects/${encodeURIComponent(projectId)}/previews`, {
        enabled,
        comments,
        baseDomain: baseDomain.trim() || undefined,
        protectionHostname: protectionHostname.trim().toLowerCase() || undefined,
      });
      const result = await api.get<{ data: Previews }>(
        `projects/${encodeURIComponent(projectId)}/previews`,
      );
      if (scope === getApiRequestScopeVersion()) setData(result.data);
    } catch (cause) {
      if (scope === getApiRequestScopeVersion())
        setError(getApiErrorMessage(cause, "Could not save preview settings."));
    } finally {
      if (scope === getApiRequestScopeVersion()) setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl bg-card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Pull request previews</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Deploy pull requests from this repository into isolated environments. New commits redeploy
          automatically. Closing a pull request or disabling previews removes its environment and
          owned volumes.
        </p>
      </div>
      {!data ? (
        <p className="text-sm text-muted-foreground">Loading preview settings…</p>
      ) : (
        <>
          <label className="block text-sm space-y-2">
            <span>Password source hostname (optional)</span>
            <Input
              variant="filled"
              placeholder="dev.example.com"
              value={protectionHostname}
              onChange={(event) => setProtectionHostname(event.target.value)}
              disabled={busy}
            />
            <span className="block text-xs text-muted-foreground">
              Set a password for this project’s exact hostname in Domains &amp; Routes first.
              Every preview hostname inherits that password before publication, with separate
              browser sessions. Requires a custom preview base domain. Leave blank for public previews.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(value) => setEnabled(value === true)}
              disabled={busy}
            />
            Enable previews for pull requests targeting this environment’s branch
          </label>
          <p className="text-xs text-muted-foreground">
            Set preview variables in Environment → Preview. Production variables are not copied.
            Fork pull requests and draft pull requests are excluded.
          </p>
          <label className="block text-sm space-y-2">
            <span>Preview base domain</span>
            <Input
              variant="filled"
              placeholder="preview.example.com"
              value={baseDomain}
              onChange={(event) => setBaseDomain(event.target.value)}
              disabled={busy}
            />
            <span className="block text-xs text-muted-foreground">
              Point wildcard DNS for this domain at the deployment server. Leave blank to use
              managed domains when available.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={comments}
              onCheckedChange={(value) => setComments(value === true)}
              disabled={busy}
            />
            Update one PR comment with deployment status and preview links
          </label>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save preview settings"}
          </Button>
          {data.previews.length > 0 && (
            <ul className="space-y-2">
              {data.previews.map((row) => (
                <li key={row.id} className="rounded-xl bg-background p-3 text-sm">
                  <div className="flex flex-wrap gap-3">
                    <span>
                      PR #{row.number} · {row.status}
                    </span>
                    {row.url && (
                      <a
                        className="text-primary underline"
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open preview
                      </a>
                    )}
                    {row.projectId && (
                      <a
                        className="text-primary underline"
                        href={`/projects/${encodeURIComponent(row.projectId)}`}
                      >
                        Environment
                      </a>
                    )}
                  </div>
                  {row.error && <p className="mt-1 text-danger">{row.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

export function BuildCacheMigration({
  projectId,
  serviceId,
}: {
  projectId: string;
  serviceId?: string;
}) {
  const [data, setData] = useState<Caches | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const scope = getApiRequestScopeVersion();
    setData(null);
    setError("");
    api
      .post<{ data: Caches }>(`projects/${encodeURIComponent(projectId)}/build-cache/migration`, {
        serviceId,
      })
      .then((result) => {
        if (live && scope === getApiRequestScopeVersion()) setData(result.data);
      })
      .catch((cause) => {
        if (live && scope === getApiRequestScopeVersion())
          setError(getApiErrorMessage(cause, "Could not inspect build cache migration."));
      });
    return () => {
      live = false;
    };
  }, [projectId, serviceId]);
  if (!data?.candidates.length && !error) return null;
  const migrate = async () => {
    const scope = getApiRequestScopeVersion();
    setBusy(true);
    setError("");
    try {
      await api.post(`projects/${encodeURIComponent(projectId)}/build-cache/migration`, {
        serviceId,
        remove: data!.candidates.map((item) => item.spec),
      });
      if (scope === getApiRequestScopeVersion()) setData(null);
    } catch (cause) {
      if (scope === getApiRequestScopeVersion())
        setError(getApiErrorMessage(cause, "Could not migrate build caches."));
    } finally {
      if (scope === getApiRequestScopeVersion()) setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl bg-card p-5 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Managed build caches</h3>
      <p className="text-sm text-muted-foreground">
        {data?.canMigrate
          ? "Managed caches succeeded on a deployment. Remove the duplicate manual mounts from future deployments; existing cache volume data is retained."
          : "Manual cache mounts will remain until a deployment succeeds using managed caches. Managed caches are used automatically by supported Docker builders."}
      </p>
      {data?.candidates.map((item) => (
        <p className="text-xs font-mono break-all" key={item.spec}>
          {item.spec}
        </p>
      ))}
      <Button type="button" disabled={busy || !data?.canMigrate} onClick={migrate}>
        {busy ? "Migrating…" : "Use managed caches"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
