"use client";

import { useEffect, useRef, useState } from "react";
import { reportCaughtError } from "@repo/core/diagnostics";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { useToast } from "@/context/ToastContext";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { getApiErrorMessage } from "@/lib/api";
import { getApiRequestScopeVersion } from "@/lib/api/client";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { authorizeConnection } from "@/lib/authorize-connection";

export function OblienServerConnection({
  onConnected,
}: {
  onConnected: (server: ServerInfo) => void;
}) {
  const scope = useResourceScope();
  const { showToast } = useToast();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Credential[]>([]);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    setAvailable(false);
    setBusy(false);
    setSaved([]);
    void credentialsApi
      .providers()
      .then(async ({ data }) => {
        if (!active || !data.some((p) => p.id === "oblien" && p.authorization?.available)) return;
        setAvailable(true);
        const result = await credentialsApi.list();
        if (active)
          setSaved(result.data.filter((c) => c.provider === "oblien" && c.status === "active"));
      })
      .catch((error) => {
        if (active) reportCaughtError(error, "dashboard/components/servers/oblien-server-connection");
      });
    return () => {
      active = false;
      operation.current?.abort();
      operation.current = null;
    };
  }, [scope]);

  async function connect(setup?: "new", existing?: Credential) {
    if (operation.current) return;
    const controller = new AbortController();
    const version = getApiRequestScopeVersion();
    operation.current = controller;
    setBusy(true);
    try {
      const credential =
        existing ??
        (await authorizeConnection(
          "oblien",
          `Oblien VM ${crypto.randomUUID()}`,
          controller.signal,
          "Your connection request expired. Connect again to start a fresh request.",
          setup,
        ));
      if (version !== getApiRequestScopeVersion() || controller.signal.aborted) return;
      if (!existing)
        setSaved((list) => [...list.filter((c) => c.id !== credential.id), credential]);
      const server = await systemApi.createServerEntry({ oblienCredentialId: credential.id });
      if (version === getApiRequestScopeVersion() && !controller.signal.aborted)
        onConnected(server);
    } catch (error) {
      if (!controller.signal.aborted && version === getApiRequestScopeVersion())
        showToast(getApiErrorMessage(error, "Unable to connect this VM."), "error", "Oblien");
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }
  if (!available) return null;
  return (
    <section aria-label="Connect an Oblien VM" aria-busy={busy} className="mb-5 rounded-2xl bg-card p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <FeatureIllustration name="server-management" className="illustration-color h-auto w-14 shrink-0 sm:w-16" />
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight text-foreground">Connect with Oblien</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Deploy to a machine in your Oblien account. You choose which VM this organization can access.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {([
          { setup: undefined, icon: "server", title: "Connect an existing VM", hint: "Choose a machine and review access." },
          { setup: "new", icon: "cloud", title: "Get a VM from Oblien", hint: "Choose compute and pay in Oblien." },
        ] as const).map(option => (
          <button key={option.title} type="button" disabled={busy} aria-label={option.title}
            onClick={() => void connect(option.setup)}
            className="group flex items-center gap-3 rounded-xl bg-secondary px-3.5 py-3 text-start text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
            <Icon name={option.icon} aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{option.title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{option.hint}</span>
            </span>
            <Icon name="external-link" aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
      {saved.length > 0 && (
        <details className="group/saved mt-3 text-sm">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-1 font-medium text-muted-foreground hover:text-foreground">
            Previously authorized VMs
            <Icon name="chevron-down" className="size-3.5 group-open/saved:rotate-180" />
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {saved.map(c => <Button key={c.id} disabled={busy} size="sm" variant="secondary" onClick={() => void connect(undefined, c)}>
              <Icon name="server" className="size-4" />{c.publicFields.vmName || c.publicFields.vmId}
            </Button>)}
          </div>
        </details>
      )}
    </section>
  );
}
