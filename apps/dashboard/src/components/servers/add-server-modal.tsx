"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { usePlatform } from "@/context/PlatformContext";
import {
  ManagedServerSetup,
  ServerAcquisitionPicker,
  type ServerAcquisitionMode,
} from "./ServerAcquisition";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useSession } from "@/lib/auth-client";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";
import { useI18n } from "@/components/i18n-provider";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useModal } from "@/context/ModalContext";
import { ServerForm } from "./server-form";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";

function AddServerDialog({
  onCancel,
  onManaged,
  onConnected,
  connectedOnly = false,
  migrationSource = false,
  initialMode,
}: {
  onCancel: () => void;
  onManaged: (
    server: CloudWorkspaceSummary,
    needsPlan: boolean,
    checkoutUrl?: string,
  ) => Promise<void>;
  onConnected: (server: ServerInfo) => void;
  connectedOnly?: boolean;
  migrationSource?: boolean;
  initialMode?: ServerAcquisitionMode;
}) {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const [mode, setMode] = useState<ServerAcquisitionMode>(
    initialMode ?? (selfHosted ? "connected" : "managed"),
  );
  const managed = !connectedOnly && mode === "managed";
  const { dialog, onKeyDown } = useDialogFocus(onCancel);
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={t.servers.setup.addServer}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col outline-none"
      style={{ width: `min(${managed ? "1440px" : "720px"}, calc(100vw - 2rem))` }}
    >
      {managed && (
        <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
          <h2 className="text-lg font-semibold tracking-tight">{t.servers.setup.addServer}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCancel}
            aria-label={t.billing.workspaces.returnToSetup}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </header>
      )}
      <div className={`min-h-0 space-y-4 overflow-y-auto ${managed ? "px-5 pb-5" : ""}`}>
        {!connectedOnly && (
          <ServerAcquisitionPicker value={mode} onChange={setMode} />
        )}
        {managed ? (
          <ManagedServerSetup onReady={onManaged} preserveProject />
        ) : (
          <ServerForm
            variant="modal"
            migrationSource={migrationSource}
            onCancel={onCancel}
            onSaved={({ server }) => onConnected(server)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Open the add-server panel as a modal from anywhere a server is required.
 *
 * Every flow that needs a server (deploy, app install, mail setup, backup
 * destinations, jobs, migrations) used to dead-end at "connect a server first"
 * plus a link to /servers/new — a full navigation that threw away whatever the
 * user had configured. Adding a server is a 30-second credentials form, so it
 * belongs on top of the flow, not instead of it.
 *
 * The panel is the same ServerForm the /servers routes render, in its modal
 * chrome: credentials only, no component-install step (that can be finished on
 * the server detail page later).
 *
 * `onCreated` receives the saved server so the caller can select it right away.
 */
export function useAddServerModal({
  connectedOnly = false,
  migrationSource = false,
  initialMode,
}: {
  connectedOnly?: boolean;
  migrationSource?: boolean;
  initialMode?: ServerAcquisitionMode;
} = {}) {
  const { showModal, hideModal } = useModal();
  const { data: session } = useSession();
  const contextKey = `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`;
  const openDialogs = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const id of openDialogs.current) hideModal(id);
      openDialogs.current.clear();
    },
    [contextKey, hideModal],
  );

  return useCallback(
    (onCreated?: (server: ServerInfo) => void) => {
      let id = "";
      let active = true;
      id = showModal({
        width: "auto",
        maxWidth: "calc(100vw - 2rem)",
        maxHeight: "calc(100dvh - 2rem)",
        overflow: "hidden",
        showCloseButton: false,
        onClose: () => {
          active = false;
          openDialogs.current.delete(id);
        },
        // Pickers live inside other modals (backup destination, adopt mail,
        // the migration wizard), and a plain <Modal> defaults to z-10000 — the
        // same value ModalContext hands out first, which would leave this panel
        // tied with its own host. Sit deliberately above it.
        zIndex: 10500,
        customContent: (
          <AddServerDialog
            initialMode={initialMode}
            connectedOnly={connectedOnly}
            migrationSource={migrationSource}
            onCancel={() => hideModal(id)}
            onManaged={async (managed, needsPlan, checkoutUrl) => {
              if (!active) return;
              const server = await systemApi.getServerById(managed.serverId);
              if (!active) return;
              onCreated?.(server);
              hideModal(id);
              if (!needsPlan) return;
              let plansId = "";
              plansId = showModal({
                width: "100%",
                maxWidth: checkoutUrl ? "560px" : "1440px",
                maxHeight: "calc(100dvh - 2rem)",
                overflow: "hidden",
                showCloseButton: false,
                zIndex: 10500,
                onClose: () => {
                  openDialogs.current.delete(plansId);
                },
                customContent: (
                  <CloudDeployPlanModal
                    workspaceId={managed.id}
                    serverName={managed.name}
                    initialCheckoutUrl={checkoutUrl}
                    onClose={() => hideModal(plansId)}
                  />
                ),
              });
              openDialogs.current.add(plansId);
            }}
            onConnected={(server) => {
              if (!active) return;
              hideModal(id);
              onCreated?.(server);
            }}
          />
        ),
      });
      openDialogs.current.add(id);
      return id;
    },
    [showModal, hideModal, contextKey, connectedOnly, migrationSource, initialMode],
  );
}
