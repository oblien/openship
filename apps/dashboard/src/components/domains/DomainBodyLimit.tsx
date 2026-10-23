"use client";

import { useRef, useState } from "react";
import { coerceProxyValue, PROXY_DIRECTIVE_BY_KEY } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { domainsApi } from "@/lib/api/domains";
import { projectsApi, type DomainBodyLimitState } from "@/lib/api/projects";
import { getApiErrorMessage } from "@/lib/api/client";

/** Reads the existing project Edge report; saving desired state is never an
 * acknowledgement that nginx has applied it. Each domain remains independent. */
export default function DomainBodyLimit({
  domainId,
  hostname,
  projectId,
  supported,
}: {
  domainId: string;
  hostname: string;
  projectId: string;
  supported: boolean;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.domains.bodyLimit;
  const [state, setState] = useState<DomainBodyLimitState | null>(null);
  const [mode, setMode] = useState<"inherit" | "custom">("inherit");
  const [value, setValue] = useState("");
  const [savedCap, setSavedCap] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const loading = useRef(false);
  const hasLoaded = useRef(false);

  async function refresh() {
    const request = ++sequence.current;
    const [domain, edge] = await Promise.all([
      domainsApi.get(domainId),
      projectsApi.getEdgeConfig(projectId),
    ]);
    if (request !== sequence.current) return;
    const host = edge.hosts.find((row) => row.hostname.toLowerCase() === hostname.toLowerCase());
    const cap = domain.data.proxy?.clientMaxBodySize;
    setSavedCap(cap);
    setMode(cap === undefined ? "inherit" : "custom");
    setValue(cap ?? "");
    setState(host?.bodyLimit ?? null);
    hasLoaded.current = true;
    setLoaded(true);
  }

  async function load() {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      reportCaughtError(cause, "dashboard/domains/body-limit");
      setState(null);
      setError(getApiErrorMessage(cause));
    } finally {
      loading.current = false;
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await domainsApi.update(domainId, {
        proxy: mode === "inherit" ? null : { clientMaxBodySize: value },
      });
    } catch (cause) {
      reportCaughtError(cause, "dashboard/domains/body-limit");
      setError(getApiErrorMessage(cause));
    }
    // Also refresh after failure: the DB may have saved while reload failed.
    try {
      await refresh();
    } catch (cause) {
      reportCaughtError(cause, "dashboard/domains/body-limit");
      setState(null);
      setError((previous) => previous ?? getApiErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const valid =
    mode === "inherit" ||
    (value.length <= 32 &&
      value.trim() === value &&
      coerceProxyValue(PROXY_DIRECTIVE_BY_KEY.get("clientMaxBodySize")!, value) !== undefined);
  const display = (cap: string | undefined | null) =>
    cap === "0" ? copy.unlimited : (cap ?? copy.unknown);
  return (
    <details
      className="rounded-xl bg-card p-4"
      onToggle={(event) => {
        if (event.currentTarget.open && !hasLoaded.current && !loading.current && supported)
          void load();
      }}
    >
      <summary className="cursor-pointer text-sm font-medium">{copy.title}</summary>
      <div className="mt-3 space-y-3 text-xs">
        <p className="text-muted-foreground">{copy.hint}</p>
        {!supported ? (
          <p>{copy.unsupported}</p>
        ) : (
          <>
            {loaded ? (
              <dl className="grid grid-cols-2 gap-2">
                <dt>{copy.saved}</dt>
                <dd>{savedCap === undefined ? copy.inherit : display(savedCap)}</dd>
                <dt>{copy.effective}</dt>
                <dd>{display(state?.effective)}</dd>
                <dt>{copy.source}</dt>
                <dd>{state ? copy[state.source] : copy.unknown}</dd>
                <dt>{copy.observed}</dt>
                <dd>{display(state?.observed)}</dd>
                <dt>{copy.status}</dt>
                <dd>
                  {state?.applied === true
                    ? copy.applied
                    : state?.applied === false
                      ? copy.pending
                      : copy.unknown}
                </dd>
              </dl>
            ) : null}
            <CustomSelect
              aria-label={copy.title}
              value={mode}
              onChange={setMode}
              disabled={busy || !loaded}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
              options={[
                { value: "inherit", label: copy.inherit },
                { value: "custom", label: copy.custom },
              ]}
            />
            {mode === "custom" ? (
              <Input
                aria-label={copy.custom}
                variant="filled"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="2m"
                maxLength={32}
                disabled={busy}
                aria-invalid={!valid}
              />
            ) : null}
            {!valid ? (
              <p role="alert" className="text-destructive">
                {copy.invalid}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || !loaded || !valid} onClick={() => void save()}>
                {busy ? copy.saving : copy.save}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>
                {copy.refresh}
              </Button>
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
