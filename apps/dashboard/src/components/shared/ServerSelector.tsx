"use client";

import { useEffect, useRef, useState } from "react";
import type { ServerDetail } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import type { ServerInfo } from "@/lib/api/system";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { useAddServerModal } from "@/components/servers/add-server-modal";
import { ServerPicker, ServerRowContent } from "@/components/shared/ServerPicker";
import { Button } from "@/components/ui/button";
import { usePlatform } from "@/context/PlatformContext";
import { settingsApi } from "@/lib/api/settings";
import { serverPreference } from "@/lib/server-preference";
import { DESKTOP_LOCAL_DEPLOY_ENABLED } from "@/hooks/useLocalDeployGate";
import { dockerMigrationApi } from "@/lib/api/server-migration";
import { getApiErrorMessage } from "@/lib/api/client";

export interface ServerOption {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  raw: ServerInfo;
}
export interface ServerSelectorProps {
  onSelect: (server: ServerOption | null) => void;
  value?: string | null;
  label?: string;
  disabled?: boolean;
  /** Saved bindings can deploy without permission to list other servers. */
  readOnly?: boolean;
  selectedName?: string;
  disabledReason?: string;
  onReadyChange?: (ready: boolean) => void;
  compact?: boolean;
  autoSelectFirst?: boolean;
  useSavedDefault?: boolean;
  excludeIds?: string[];
  emptyHint?: string;
  forDeployment?: boolean;
  requiredCapability?: keyof NonNullable<ServerDetail["capabilities"]>;
  /** Cloud import sources use this same picker with a restricted inventory. */
  migrationSource?: boolean;
}

function option(server: ServerDetail | ServerInfo): ServerOption {
  return {
    id: server.id,
    name: server.name || server.sshHost || server.id,
    host: server.sshHost ?? "",
    user: server.sshUser ?? "",
    port: server.sshPort ?? 22,
    raw: { ...server, sshUser: server.sshUser ?? "", sshPort: server.sshPort ?? 22 },
  };
}

function ServerSummary({ name, description }: { name: string; description?: string }) {
  return (
    <div className="rounded-xl bg-muted/30 px-4 py-3">
      <p className="break-words text-sm font-medium">{name}</p>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Selection stays mounted when a wizard switches between its summary and editor. */
export function useServerSelection({
  onSelect,
  value,
  disabled = false,
  readOnly = false,
  selectedName,
  disabledReason,
  onReadyChange,
  autoSelectFirst = false,
  useSavedDefault = false,
  excludeIds,
  forDeployment = false,
  requiredCapability,
  migrationSource = false,
}: ServerSelectorProps, enabled = true) {
  const { selfHosted, deployMode } = usePlatform();
  const restrictedSource = migrationSource && !selfHosted;
  const { data, loading: destinationsLoading, error, refresh, contextKey } = useServerDestinations(enabled && !readOnly, restrictedSource ? "migration-source" : "deployment");
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preference, setPreference] = useState<{ contextKey: string; serverId: string | null } | null>(null);
  const loadingPreference = useSavedDefault && !readOnly && preference?.contextKey !== contextKey;
  const loading = destinationsLoading || loadingPreference;
  const [internalId, setInternalId] = useState<string | null>(null);
  const autoSelected = useRef(false);
  const canAddServer = restrictedSource || selfHosted || requiredCapability !== "ssh";
  const openAddServer = useAddServerModal({ connectedOnly: requiredCapability === "ssh" || restrictedSource, migrationSource: restrictedSource });
  const selectedId = value === undefined ? internalId : value;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectionContext = useRef(contextKey);
  selectionContext.current = contextKey;

  useEffect(() => {
    autoSelected.current = false;
    setInternalId(null);
    setActionError(null);
    setRemoving(false);
  }, [contextKey]);

  useEffect(() => {
    if (!enabled || readOnly || !useSavedDefault) return;
    let active = true;
    void settingsApi.get().then(
      (settings) => { if (active) setPreference({ contextKey, serverId: settings.defaultServerId }); },
      () => { if (active) setPreference({ contextKey, serverId: null }); },
    );
    return () => { active = false; };
  }, [enabled, readOnly, useSavedDefault, contextKey]);

  const rows = (data?.servers ?? []).filter((server) => {
    if (!restrictedSource && requiredCapability && !server.capabilities?.[requiredCapability]) return false;
    if (excludeIds?.includes(server.id)) return false;
    if (!server.managed) return true;
    return (
      server.id === selectedId ||
      !forDeployment ||
      server.managed.state !== "deleting"
    );
  });
  const ids = rows.map((row) => row.id).join(",");
  const automaticCloud =
    !selfHosted && forDeployment && data?.servers.length === 0 && !selectedId;
  useEffect(() => {
    if (
      !enabled || disabled || readOnly || loading || error ||
      selectedId ||
      (!autoSelectFirst && value === null) ||
      autoSelected.current
    )
      return;
    if (automaticCloud) {
      autoSelected.current = true;
      onSelectRef.current(null);
    } else if (rows.length === 1 || (autoSelectFirst && rows.length > 0)) {
      autoSelected.current = true;
      const remembered = useSavedDefault ? serverPreference(contextKey).read() : null;
      const preferred = rows.find(row => row.id === preference?.serverId)
        ?? rows.find(row => row.id === remembered)
        ?? (useSavedDefault ? rows.find(row => deployMode === "desktop" && !DESKTOP_LOCAL_DEPLOY_ENABLED ? !row.isLocal : row.isLocal) : undefined)
        ?? rows[0]!;
      const selected = option(preferred);
      setInternalId(selected.id);
      onSelectRef.current(selected);
    }
  }, [ids, enabled, disabled, readOnly, loading, error, selectedId, autoSelectFirst, value, contextKey, automaticCloud, useSavedDefault, preference, deployMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectionReady = enabled && (readOnly ? Boolean(selectedId) : !loading && !error && (
    automaticCloud || rows.some((server) => server.id === selectedId && server.managed?.state !== "deleting")
  ));
  useEffect(() => {
    onReadyChange?.(selectionReady);
  }, [selectionReady, onReadyChange]);

  function addServer() {
    if (!canAddServer) return;
    const owner = contextKey;
    openAddServer((server) => {
      if (selectionContext.current !== owner) return;
      if ((!restrictedSource && requiredCapability && !server.capabilities?.[requiredCapability]) || excludeIds?.includes(server.id)) {
        refresh();
        return;
      }
      autoSelected.current = true;
      setInternalId(server.id);
      onSelectRef.current(option(server));
      refresh();
    });
  }
  const select = (id: string) => {
    autoSelected.current = true;
    setInternalId(id);
    const server = rows.find((row) => row.id === id);
    onSelectRef.current(server ? option(server) : null);
  };
  const removeSource = async () => {
    if (!restrictedSource || !selectedId || removing) return;
    const owner = contextKey;
    setRemoving(true); setActionError(null);
    try {
      await dockerMigrationApi.deleteSource(selectedId);
      if (selectionContext.current !== owner) return;
      autoSelected.current = false;
      setInternalId(null);
      onSelectRef.current(null);
      refresh();
    } catch (error) {
      if (selectionContext.current === owner) setActionError(getApiErrorMessage(error));
    } finally { if (selectionContext.current === owner) setRemoving(false); }
  };
  return {
    rows, selectedId, selected: rows.find(server => server.id === selectedId),
    loading, error, refresh, automaticCloud, ready: selectionReady,
    disabled, readOnly, selectedName, disabledReason, forDeployment, canAddServer, addServer, select,
    restrictedSource, removeSource, removing, actionError,
    remember: () => { if (selectionReady && selectedId) serverPreference(contextKey).write(selectedId); },
  };
}

export type ServerSelection = ReturnType<typeof useServerSelection>;

/** Render the same picker against a form-owned selection, without a second fetch or seed. */
export function ServerSelectorView({
  selection,
  label,
  compact = false,
  emptyHint,
}: Pick<ServerSelectorProps, "label" | "compact" | "emptyHint"> & { selection: ServerSelection }) {
  const { t } = useI18n();
  const copy = t.widgets.shared.serverSelector;
  const managedCopy = t.billing.workspaces;
  const { selfHosted } = usePlatform();
  const {
    rows, selectedId, loading, error, refresh, automaticCloud, disabled,
    readOnly, selectedName, disabledReason, forDeployment, canAddServer, addServer, select,
    restrictedSource, removeSource, removing, actionError,
  } = selection;
  const effective = selectedId ?? "";
  const addLabel = restrictedSource ? t.migration.sources.connect : !selfHosted && forDeployment ? managedCopy.newProjectServer : copy.addNewServer;
  return (
    <div className={compact ? "space-y-2" : "mb-5 space-y-2"}>
      {!compact && (
        <label className="block text-sm font-medium text-foreground">
          {label ?? copy.serverLabel}
        </label>
      )}
      {readOnly ? (
        <ServerSummary
          name={selectedName || (selectedId ? managedCopy.singular : copy.loadingServers)}
          description={disabledReason}
        />
      ) : loading ? (
        <div
          aria-busy="true"
          aria-label={copy.loadingServers}
          className="h-16 animate-pulse rounded-xl bg-muted/50"
        />
      ) : error ? (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{error}</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      ) : automaticCloud ? (
        <ServerSummary name={t.deploy.targetStep.options.cloud} description={managedCopy.defaultHint} />
      ) : rows.length > 0 ? (
        <>
          {rows.length === 1 && effective === rows[0]!.id ? (
            <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-4 py-3">
              <ServerRowContent server={rows[0]!} active />
            </div>
          ) : (
            <ServerPicker
              label={label ?? copy.serverLabel}
              showLabel={false}
              selectedId={effective}
              servers={rows}
              disabled={disabled}
              onSelect={server => select(server.id)}
              onAddServer={canAddServer && !disabled && !disabledReason ? addServer : undefined}
              addServerLabel={addLabel}
            />
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/30 p-4">
          <p className="min-w-0 text-sm text-muted-foreground">
            {emptyHint ?? (restrictedSource ? t.migration.sources.empty : selfHosted ? copy.noServerConnected : managedCopy.noneAvailable)}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || !canAddServer}
            onClick={addServer}
          >
            <Icon name="plus" className="size-3.5" aria-hidden />
            {restrictedSource ? addLabel : copy.addServer}
          </Button>
        </div>
      )}
      {!readOnly && !loading && !error && (automaticCloud || rows.length > 0) && (
        disabledReason ? (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        ) : !disabled && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!selfHosted && (
              <p className="text-xs text-muted-foreground">
                {restrictedSource ? t.migration.sources.hint : forDeployment && !automaticCloud ? managedCopy.existingServerHint : managedCopy.subscriptionHint}
              </p>
            )}
            {canAddServer && (automaticCloud || rows.length === 1) && (
              <Button type="button" variant="secondary" size="sm" onClick={addServer}>
                <Icon name="plus" className="size-3.5" aria-hidden />
                {addLabel}
              </Button>
            )}
            {restrictedSource && effective && <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={removeSource}>
              {t.migration.sources.disconnect}
            </Button>}
          </div>
        )
      )}
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
    </div>
  );
}

/** Standalone forms use the same selection state and view. */
export default function ServerSelector(props: ServerSelectorProps) {
  const selection = useServerSelection(props);
  return <ServerSelectorView selection={selection} label={props.label} compact={props.compact} emptyHint={props.emptyHint} />;
}
