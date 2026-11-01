"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { useLocalhostForward } from "@/hooks/useLocalhostForward";
import type { Service, ServiceContainer } from "@/lib/api/services";
import { serviceLocalhostTarget } from "@/lib/service-endpoints";

export function ServiceLocalhostAction({
  service,
  container,
  serverId,
  deployTarget,
}: {
  service: Service;
  container?: ServiceContainer;
  serverId?: string | null;
  deployTarget?: string | null;
}) {
  const { t } = useI18n();
  const id = useId();
  const { canForward, forward } = useLocalhostForward({ serverId, deployTarget });
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const [choosingPort, setChoosingPort] = useState(false);
  const [port, setPort] = useState("");
  const target = serviceLocalhostTarget(service, container);
  const customPort = Number(port);
  const validPort = Number.isInteger(customPort) && customPort > 0 && customPort <= 65535;
  const canChoosePort = !!target && target.remoteHost === container?.ip;

  const open = async (explicitPort?: number) => {
    if (!canForward || !target || openingRef.current) return;
    // A manually entered port belongs to the container, never the SSH host.
    if (explicitPort !== undefined && (!canChoosePort || !validPort)) return;
    const remotePort = explicitPort ?? target.remotePort;
    if (!remotePort) return;
    openingRef.current = true;
    setOpening(true);
    try {
      if (await forward(remotePort, "open", target.remoteHost)) setChoosingPort(false);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  if (!canForward) return null;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          if (target?.remotePort) void open();
          else if (target) setChoosingPort(true);
        }}
        disabled={opening || !target}
        title={t.projects.connections.openLocalhost}
        className="h-9"
      >
        <Icon name="devices" className={opening ? "size-3.5 animate-pulse" : "size-3.5"} />
        {t.projects.connections.openLocalhost}
      </Button>
      <Modal
        isOpen={choosingPort}
        onClose={() => setChoosingPort(false)}
        closable={!opening}
        showCloseButton={false}
        width="100%"
        maxWidth="26rem"
      >
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          className="space-y-5 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void open(customPort);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !opening) setChoosingPort(false);
          }}
        >
          <div>
            <h3 id={`${id}-title`} className="text-base font-semibold">
              {t.projects.connections.openLocalhost}
            </h3>
            <p className="mt-1 truncate text-sm text-muted-foreground">{service.name}</p>
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-port`} className="block text-sm font-medium">
              {t.servers.ports.remotePortPlaceholder} (TCP)
            </label>
            <Input
              id={`${id}-port`}
              type="number"
              variant="filled"
              min={1}
              max={65535}
              step={1}
              required
              autoFocus
              value={port}
              onChange={(event) => setPort(event.target.value)}
              disabled={opening}
              aria-invalid={port !== "" && !validPort}
              aria-describedby={port !== "" && !validPort ? `${id}-error` : undefined}
            />
            {port !== "" && !validPort && (
              <p id={`${id}-error`} role="alert" className="text-xs text-danger">
                {t.servers.ports.toastRemotePortRange}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={opening}
              onClick={() => setChoosingPort(false)}
            >
              {t.projectSettings.settingSection.cancel}
            </Button>
            <Button type="submit" disabled={opening || !canChoosePort || !validPort}>
              {opening && <Icon name="spinner" className="size-4 animate-spin" />}
              {t.projects.connections.openLocalhost}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
