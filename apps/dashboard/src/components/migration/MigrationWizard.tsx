"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { Icon } from "@repo/ui/icons";
import type { MigrationSourceKind } from "@repo/core";
import { AppLogo } from "@/components/AppLogo";
import { useSession } from "@/lib/auth-client";
import { getApiBaseUrl, getApiErrorMessage } from "@/lib/api/client";
import { dockerMigrationApi } from "@/lib/api/server-migration";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ServerMigrationWizard } from "./ServerMigrationWizard";
import { PlatformMigrationWizard } from "./PlatformMigrationWizard";

type Props = ComponentProps<typeof ServerMigrationWizard> & {
  source?: MigrationSourceKind | null;
  onSourceChange?: (source: MigrationSourceKind | null) => void;
};
const sources: Array<{
  id: MigrationSourceKind;
  name: string;
  description: string;
  detail: string;
}> = [
  {
    id: "server",
    name: "Server or Docker",
    description: "Move existing Docker workloads from a server you own.",
    detail: "Containers, databases and volumes",
  },
  {
    id: "railway",
    name: "Railway",
    description: "Bring a project and its connected services from Railway.",
    detail: "Repositories, databases and volumes",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Move a deployed application and its settings from Vercel.",
    detail: "Repositories and linked PostgreSQL",
  },
];

export function MigrationWizard(props: Props) {
  const { data } = useSession();
  const scope = `${data?.user.id ?? "local"}:${data?.session.activeOrganizationId ?? ""}:${getApiBaseUrl()}`;
  return (
    <ScopedMigrationWizard
      key={`${scope}:${props.initialRunId ?? ""}:${props.serverId ?? ""}`}
      {...props}
    />
  );
}

function ScopedMigrationWizard(props: Props) {
  const [localSource, setLocalSource] = useState<MigrationSourceKind | null>(
    props.origin === "project" && !props.initialRunId ? "server" : null,
  );
  // Existing runs and project moves resolve their own source. Only the Library
  // uses a controlled source so links and browser history track the selection.
  const controlled =
    !props.initialRunId && props.origin !== "project" && props.source !== undefined;
  const source = controlled ? props.source : localSource;
  const selectSource = (next: MigrationSourceKind | null) => {
    if (controlled) props.onSourceChange?.(next);
    else setLocalSource(next);
  };
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const visible = props.variant === "tab" || props.isOpen;
  useEffect(() => {
    if (!visible || !props.initialRunId) return;
    let cancelled = false;
    void dockerMigrationApi
      .getMigration(props.initialRunId)
      .then(({ run }) => {
        if (cancelled) return;
        const provider = run.inputSnapshot?.provider;
        if (run.mode === "provider_import" && (provider === "railway" || provider === "vercel"))
          setLocalSource(provider);
        else setLocalSource("server");
      })
      .catch((error) => {
        if (!cancelled) setError(getApiErrorMessage(error, "The migration could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, props.initialRunId, retry]);
  if (!visible) return null;
  if (source === "server")
    return (
      <ServerMigrationWizard
        {...props}
        onBack={
          props.initialRunId || props.origin === "project" ? props.onBack : () => selectSource(null)
        }
      />
    );
  const back = props.initialRunId ? (props.onBack ?? props.onClose) : () => selectSource(null);
  const content = source ? (
    <PlatformMigrationWizard
      key={source}
      provider={source}
      onBack={back}
      initialRunId={props.initialRunId}
      initialTargetId={props.serverId}
    />
  ) : props.initialRunId ? (
    <div className="rounded-2xl bg-card p-5">
      {error ? (
        <>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading migration…
        </p>
      )}
    </div>
  ) : (
    <div className="w-full space-y-7 py-3">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">Where are you moving from?</h2>
        <p className="text-sm text-muted-foreground">
          Connect your platform, choose what to bring, and review the import.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {sources.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => selectSource(item.id)}
            className="group flex h-full flex-col rounded-2xl bg-card p-6 text-start transition-colors hover:bg-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex w-full items-center gap-3">
              <span className="flex size-12 items-center justify-center">
                {item.id === "server" ? (
                  <Icon name="docker" className="size-9" />
                ) : (
                  <AppLogo slug={item.id} className="size-9" />
                )}
              </span>
              <span className="flex-1 text-lg font-semibold">{item.name}</span>
            </div>
            <p className="mb-8 mt-5 text-sm leading-relaxed text-muted-foreground">
              {item.description}
            </p>
            <div className="mt-auto flex items-center gap-4 text-xs">
              <span className="flex-1 text-muted-foreground">{item.detail}</span>
              <Icon name="arrow-right" className="size-4" />
            </div>
          </button>
        ))}
      </div>
      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Icon name="shield" className="size-4" />
        Review everything before importing. Move your domains when you’re ready.
      </p>
    </div>
  );
  return props.variant === "tab" ? (
    content
  ) : (
    <Modal isOpen={!!props.isOpen} onClose={props.onClose} width="1120px" maxWidth="95vw">
      <div className="p-6">{content}</div>
    </Modal>
  );
}
