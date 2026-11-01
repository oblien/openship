"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { OptionCard } from "@/components/shared/OptionCard";
import { useI18n, interpolate } from "@/components/i18n-provider";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { ServerRowContent } from "@/components/shared/ServerPicker";
import { instanceApi, type InstanceStatus, type InstanceHostMapping } from "@/lib/api/instance";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { UpgradeAuthForm } from "./UpgradeAuthModal";
import { InstanceConnectDialog } from "./InstanceConnectDialog";

type Action = "move" | "receive" | "send" | "connect" | "pair" | "return" | "previous";
const pending = (state: InstanceStatus) =>
  !!state.handoff && !["complete", "aborted"].includes(state.handoff.status);

export function instanceProgress(state: InstanceStatus): string {
  if (!state.handoff) return "Connecting to your instance";
  if (state.handoff.status === "complete") return "Connected to the active instance";
  if (state.role === "quiescing") return "Waiting for current operations to finish";
  if (state.handoff.provisioning && state.role === "active")
    return "Preparing Openship on your server";
  return {
    offered: "Waiting for the other instance",
    frozen: "Transferring your instance",
    copying: "Receiving your instance",
    prepared: "Verifying the handoff",
    retired: "Connecting to the new control plane",
    aborted: "Move cancelled",
  }[state.handoff.status];
}

/** Used both in Settings and by the recovery screen before the normal shell can
 * authenticate. Polling keeps its last state across an intentional API restart. */
export function useInstanceStatus(initial?: InstanceStatus) {
  const [state, setState] = useState(initial ?? null);
  const [error, setError] = useState("");
  const [errorStatus, setErrorStatus] = useState<number>();
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await instanceApi.status();
      if (mounted.current) {
        setState(next);
        setError("");
        setErrorStatus(undefined);
      }
      return next;
    } catch (err) {
      if (mounted.current) {
        setError(getApiErrorMessage(err));
        setErrorStatus(err instanceof ApiError ? err.status : undefined);
      }
      return null;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    if (errorStatus === 403)
      return () => {
        mounted.current = false;
      };
    const timer = setInterval(() => void refresh(), state && pending(state) ? 2_000 : 15_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, errorStatus, state?.handoff?.status]);
  return { state, error, errorStatus, refresh };
}

export function InstanceProgress({
  state,
  refresh,
}: {
  state: InstanceStatus;
  refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const h = state.handoff;
  async function run(action: "resume" | "cancel") {
    setBusy(true);
    setError("");
    try {
      await instanceApi[action]();
      await refresh();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-xl bg-muted/30 p-4" aria-live="polite">
      <div className="flex items-center gap-2.5 text-sm font-medium">
        <Icon
          name={h?.error ? "alert-circle" : "spinner"}
          className={`size-4 shrink-0 ${h?.running ? "animate-spin" : ""}`}
        />
        {instanceProgress(state)}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Your apps stay on their servers. Openship pauses new operations while control moves.
      </p>
      {(error || h?.error) && (
        <p role="alert" className="whitespace-pre-line text-sm text-destructive">
          {error || h?.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!h?.running && (h?.peerOrigin || h?.provisioning) && (
          <Button size="sm" disabled={busy} onClick={() => void run("resume")}>
            Resume move
          </Button>
        )}
        {!h?.running && h && !["retired", "complete"].includes(h.status) && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run("cancel")}>
            Cancel move
          </Button>
        )}
        {h?.provisioning?.deploymentId && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/deployments/${h.provisioning.deploymentId}`}>View deployment</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function InstanceLocation({
  initial,
  recovering = false,
  moveRequested = false,
  onMoveOpened,
}: {
  initial?: InstanceStatus;
  recovering?: boolean;
  moveRequested?: boolean;
  onMoveOpened?: () => void;
}) {
  const { t } = useI18n();
  const copy = t.settings.instance.location;
  const { state, error, errorStatus, refresh } = useInstanceStatus(initial);
  const [action, setAction] = useState<Action | null>(null);
  const [actionError, setActionError] = useState("");
  const moved = useRef(false);
  const openedMove = useRef(false);
  useEffect(() => {
    if (!moveRequested) {
      openedMove.current = false;
      return;
    }
    if (openedMove.current || !state || state.role !== "active" || pending(state)) return;
    // A feature shortcut only opens the reviewed setup, after the normal
    // instance-admin status check. It never starts a move or creates an account.
    openedMove.current = true;
    setAction("move");
    onMoveOpened?.();
  }, [moveRequested, state, onMoveOpened]);
  useEffect(() => {
    if (!state) return;
    if (
      recovering &&
      state.role === "active" &&
      state.ready !== false &&
      (!state.handoff || ["aborted", "complete"].includes(state.handoff.status))
    ) {
      window.location.reload();
      return;
    }
    if (pending(state)) moved.current = true;
    if (
      moved.current &&
      state.handoff?.status === "complete" &&
      !state.handoff.running &&
      (state.role !== "active" || state.ready !== false)
    ) {
      moved.current = false;
      window.location.assign("/settings?tab=instance");
    }
  }, [state, recovering]);
  if (!state)
    return errorStatus === 403 ? (
      <section className="space-y-3 rounded-2xl bg-card p-5">
        <h2 className="text-[15px] font-semibold">
          {moveRequested ? copy.moveToServer : copy.memberTitle}
        </h2>
        <p className="text-sm text-muted-foreground">
          {moveRequested ? copy.adminRequired : copy.memberHint}
        </p>
        {!moveRequested && (
          <Button variant="secondary" onClick={() => setAction("pair")}>
            {copy.pairDesktop}
          </Button>
        )}
        {action === "pair" && (
          <InstanceMoveDialog
            action="pair"
            onClose={() => setAction(null)}
            onStarted={async () => setAction(null)}
          />
        )}
      </section>
    ) : error ? null : (
      <div className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">{copy.loading}</div>
    );
  const remote = ["retired", "connected"].includes(state.role) && !!state.connection;
  const retiredServer = !state.desktop && state.role === "retired";
  const visibleActions: Action[] = retiredServer
    ? ["receive"]
    : remote && state.desktop
      ? ["return", "connect"]
      : state.desktop
        ? ["connect", "move"]
        : ["pair", "move", "send"];
  const labels: Record<Action, string> = {
    move: state.desktop ? copy.moveToServer : copy.moveToAnotherServer,
    connect: remote ? copy.reconnect : copy.connectExisting,
    pair: copy.pairDesktop,
    receive: copy.receiveInstance,
    send: copy.moveToDesktop,
    return: copy.returnToDesktop,
    previous: copy.previousServer,
  };
  const icons: Record<Action, IconName> = {
    move: "server",
    connect: "link",
    pair: "monitor",
    receive: "download",
    send: "monitor",
    return: "monitor",
    previous: "history",
  };
  const openAction = (next: Action) => setAction(next);
  const options: MenuAction[] = [];
  const addOption = (next: Action) => {
    if (!visibleActions.includes(next))
      options.push({
        id: next,
        label: labels[next],
        icon: <Icon name={icons[next]} className="size-4" />,
        onClick: () => openAction(next),
      });
  };
  if (state.previousInstance) addOption("previous");
  if (!retiredServer && (!state.desktop || remote)) addOption("pair");
  if (!remote || retiredServer) addOption("receive");
  if (state.role === "connected")
    options.push(
      { id: "connection-divider", divider: true },
      {
        id: "disconnect",
        label: copy.disconnect,
        icon: <Icon name="logout" className="size-4" />,
        onClick: () => {
          void instanceApi
            .disconnect()
            .then(() => window.location.assign("/settings?tab=instance"))
            .catch((err) => setActionError(getApiErrorMessage(err)));
        },
      },
    );
  return (
    <section className="@container space-y-4 rounded-2xl bg-card p-5" aria-label={copy.title}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/40 text-foreground">
            <Icon name={remote || !state.desktop ? "server" : "monitor"} className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xs text-muted-foreground">{copy.title}</h2>
            <p className="mt-0.5 break-words text-base font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
              {remote
                ? state.connection!.origin.replace(/\/api\/proxy$/, "")
                : state.desktop
                  ? copy.thisDesktop
                  : copy.thisServer}
            </p>
            {!pending(state) && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {retiredServer
                  ? copy.retiredHint
                  : remote
                    ? copy.remoteHint
                    : state.desktop
                      ? copy.desktopHint
                      : copy.serverHint}
              </p>
            )}
          </div>
        </div>
        {!pending(state) && options.length > 0 && (
          <DropdownMenu
            className="shrink-0"
            actions={options}
            triggerLabel={copy.moreOptions}
            triggerClassName="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        )}
      </div>
      {!pending(state) && (
        <div className="flex flex-wrap gap-2">
          {visibleActions.map((next, index) => (
            <Button
              key={next}
              variant={index === 0 ? "default" : "secondary"}
              className="h-auto min-h-10 w-full whitespace-normal @min-[480px]:w-auto"
              onClick={() => openAction(next)}
            >
              <Icon name={icons[next]} />
              {labels[next]}
            </Button>
          ))}
        </div>
      )}
      {pending(state) ? (
        <InstanceProgress state={state} refresh={refresh} />
      ) : actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {action === "connect" ? (
        <InstanceConnectDialog onClose={() => setAction(null)} />
      ) : (
        action && (
          <InstanceMoveDialog
            action={action}
            localHosts={state.localHosts}
            previousOrigin={state.previousInstance?.origin}
            accountRequired={state.accountReady === false}
            onAccountReady={() => void refresh()}
            onClose={() => setAction(null)}
            onStarted={async () => {
              setAction(null);
              await refresh();
            }}
          />
        )
      )}
    </section>
  );
}

function CodeField({
  value,
  onChange,
  label,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  readOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">
        {label}
        <textarea
          aria-label={label}
          readOnly={readOnly}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          spellCheck={false}
          className="mt-2 min-h-24 w-full resize-y rounded-xl border-0 bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      {readOnly && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy code"}
        </Button>
      )}
    </div>
  );
}

export function InstanceMoveDialog({
  action,
  localHosts = [],
  previousOrigin,
  accountRequired = false,
  onAccountReady,
  onClose,
  onStarted,
}: {
  action: Exclude<Action, "connect">;
  localHosts?: InstanceStatus["localHosts"];
  previousOrigin?: string;
  accountRequired?: boolean;
  onAccountReady?: () => void;
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const { t } = useI18n();
  const copy = t.settings.instance.location;
  const transfer = t.settings.instance.transfer;
  const destinationId = useId();
  const receiveId = useId();
  const confirmationId = useId();
  const [destination, setDestination] = useState<"server" | "existing">("server");
  const [receiveMethod, setReceiveMethod] = useState<"code" | "offer">("code");
  const [server, setServer] = useState<ServerOption | null>(null);
  const [source, setSource] = useState<ServerOption | null>(null);
  const [access, setAccess] = useState<"desktop" | "browser">("desktop");
  const [kind, setKind] = useState<"custom" | "free">("custom");
  const [hostname, setHostname] = useState("");
  const [code, setCode] = useState("");
  const [generated, setGenerated] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [remoteHosts, setRemoteHosts] = useState<InstanceStatus["localHosts"] | null>(null);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [setupAccount, setSetupAccount] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  const needsAccount = action === "move" && accountRequired && !accountCreated;
  const close = () => {
    if (!busy) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  useEffect(() => {
    dialog.current?.focus();
  }, [setupAccount, dialog]);
  useEffect(() => {
    if (action !== "return") return;
    let current = true;
    setRemoteHosts(null);
    setSource(null);
    setError("");
    void instanceApi.connectedSource().then(
      ({ localHosts: hosts }) => {
        if (current) setRemoteHosts(hosts);
      },
      (err) => {
        if (current) setError(getApiErrorMessage(err));
      },
    );
    return () => {
      current = false;
    };
  }, [action, sourceAttempt]);
  const sourceHosts = action === "return" ? (remoteHosts ?? []) : localHosts;
  const mapping: InstanceHostMapping | undefined =
    source && sourceHosts[0]
      ? { sourceServerId: sourceHosts[0].id, connectionServerId: source.id }
      : undefined;
  const title = setupAccount
    ? copy.secureAccount
    : {
        move: accountCreated ? copy.reviewMove : "Move your instance",
        receive: copy.receiveInstance,
        send: copy.moveToDesktop,
        pair: copy.pairDesktop,
        return: "Move back to Desktop",
        previous: "Move to previous server",
      }[action];
  const description = setupAccount
    ? copy.accountHint
    : {
        move: "Your settings, users and credentials move together. Apps and volumes stay where they run.",
        receive: transfer.receiveDescription,
        send: interpolate(copy.sendHint, { action: copy.receiveInstance }),
        pair: copy.pairHint,
        return:
          "Transfer the latest remote data to this Desktop. The server stops managing your projects after the handoff.",
        previous: `Move your latest data to ${previousOrigin ?? "the previous server"}. Its saved data is replaced after a recovery snapshot is created.`,
      }[action];
  async function submit() {
    if (busy) return;
    if (needsAccount) {
      setSetupAccount(true);
      setError("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (action === "pair") {
        setGenerated((await instanceApi.pair()).code);
        return;
      }
      if (action === "send") {
        setGenerated((await instanceApi.offer("source", mapping)).code);
        return;
      }
      if (action === "previous") await instanceApi.moveToPrevious(mapping);
      else if (action === "return") await instanceApi.returnToDesktop(mapping);
      else if (action === "receive") {
        if (receiveMethod === "offer") {
          setGenerated((await instanceApi.offer("target")).code);
          return;
        }
        await instanceApi.move(code.trim());
      } else if (destination === "existing") await instanceApi.move(code.trim(), mapping);
      else {
        await instanceApi.preflight(mapping);
        await instanceApi.provision({
          serverId: server!.id,
          access,
          domain: { kind, hostname: hostname.trim() },
          mapping,
        });
      }
      await onStarted();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const needsConfirmation = action !== "pair";
  const disabled =
    busy ||
    (action === "return" && (remoteHosts === null || (sourceHosts.length > 0 && !source))) ||
    (needsConfirmation && !needsAccount && !confirmed) ||
    (action === "receive" && receiveMethod === "code" && !code.trim()) ||
    (action === "move" && (destination === "server" ? !server || !hostname.trim() : !code.trim()));
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!busy}
      maxWidth="min(680px, calc(100vw - 32px))"
      maxHeight="90dvh"
      width="100%"
      overflow="hidden"
      showCloseButton={false}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-[90dvh] min-h-0 flex-col outline-none"
        onKeyDown={onKeyDown}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={close} disabled={busy}>
            <Icon name="close" />
          </Button>
        </div>
        <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-5">
          {setupAccount && (
            <div className="space-y-5">
              {destination === "server" && server && (
                <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-4 py-3">
                  <ServerRowContent server={server.raw} />
                </div>
              )}
              <UpgradeAuthForm
                onBusyChange={setBusy}
                cancelLabel={copy.backToDestination}
                onCancel={() => setSetupAccount(false)}
                onSuccess={() => {
                  setAccountCreated(true);
                  setSetupAccount(false);
                  setConfirmed(false);
                  onAccountReady?.();
                }}
              />
            </div>
          )}
          <div hidden={setupAccount} className="space-y-5">
            {action === "move" && (
              <>
                <Tabs
                  tabs={[
                    { key: "server", label: transfer.installOnServer },
                    { key: "existing", label: transfer.existingInstance },
                  ]}
                  value={destination}
                  size="sm"
                  fullWidth
                  onChange={(next) => {
                    setDestination(next);
                    setConfirmed(false);
                    setError("");
                  }}
                  idPrefix={destinationId}
                  ariaLabel="Destination type"
                />
                <div
                  role="tabpanel"
                  id={`${destinationId}-panel-server`}
                  aria-labelledby={`${destinationId}-tab-server`}
                  hidden={destination !== "server"}
                  className="space-y-5"
                >
                  <ServerSelector
                    value={server?.id ?? null}
                    onSelect={setServer}
                    forDeployment
                    excludeIds={localHosts.map((host) => host.id)}
                    label="Destination server"
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <OptionCard
                      value="desktop"
                      selected={access === "desktop"}
                      onSelect={() => setAccess("desktop")}
                      icon={<Icon name="monitor" className="size-4" />}
                      label="Use through Desktop"
                      description="Deploy the API only. Keep this interface on your computer."
                    />
                    <OptionCard
                      value="browser"
                      selected={access === "browser"}
                      onSelect={() => setAccess("browser")}
                      icon={<Icon name="globe" className="size-4" />}
                      label="Desktop + browser"
                      description="Deploy the API and dashboard for browser access too."
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">Instance address</span>
                      <Tabs
                        tabs={[
                          { key: "custom", label: "Custom" },
                          { key: "free", label: "Free" },
                        ]}
                        value={kind}
                        onChange={setKind}
                        size="sm"
                        ariaLabel="Domain type"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label="Instance address"
                        value={hostname}
                        onChange={(e) => setHostname(e.target.value)}
                        placeholder={kind === "custom" ? "openship.example.com" : "my-openship"}
                        variant="filled"
                      />
                      {kind === "free" && (
                        <span className="text-sm text-muted-foreground">.opsh.io</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {kind === "custom"
                        ? "Point this domain to the selected server. HTTPS is checked before your data moves."
                        : "Uses the selected server’s Cloud routing connection."}
                    </p>
                  </div>
                </div>
                <div
                  role="tabpanel"
                  id={`${destinationId}-panel-existing`}
                  aria-labelledby={`${destinationId}-tab-existing`}
                  hidden={destination !== "existing"}
                  className="space-y-3"
                >
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {interpolate(transfer.destinationCodeHint, {
                      more: copy.moreOptions,
                      receive: copy.receiveInstance,
                      create: transfer.createReceiveCode,
                    })}
                  </p>
                  <CodeField
                    value={code}
                    onChange={setCode}
                    label={transfer.destinationCodeLabel}
                  />
                </div>
              </>
            )}
            {action === "return" && remoteHosts === null && !error && (
              <p role="status" className="text-sm text-muted-foreground">
                {copy.loading}
              </p>
            )}
            {(action === "move" ||
              action === "send" ||
              action === "previous" ||
              action === "return") &&
              sourceHosts.length > 0 && (
                <div className="space-y-2 rounded-xl bg-muted/30 p-4">
                  <p className="text-sm font-medium">Keep access to {sourceHosts[0].name}</p>
                  <p className="text-xs text-muted-foreground">
                    Choose its SSH connection so the new controller can still manage apps on this
                    host.
                  </p>
                  <ServerSelector
                    value={source?.id ?? null}
                    onSelect={setSource}
                    requiredCapability="ssh"
                    excludeIds={sourceHosts.map((host) => host.id)}
                    label="Source host connection"
                  />
                </div>
              )}
            {action === "receive" && !generated && (
              <div className="space-y-3">
                <Tabs
                  tabs={[
                    { key: "code", label: transfer.pasteMoveCode },
                    { key: "offer", label: transfer.createReceiveCode },
                  ]}
                  value={receiveMethod}
                  size="sm"
                  fullWidth
                  onChange={(next) => {
                    setReceiveMethod(next);
                    setConfirmed(false);
                    setError("");
                  }}
                  idPrefix={receiveId}
                  ariaLabel={copy.receiveInstance}
                />
                <div
                  role="tabpanel"
                  id={`${receiveId}-panel-code`}
                  aria-labelledby={`${receiveId}-tab-code`}
                  hidden={receiveMethod !== "code"}
                  className="space-y-3"
                >
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {interpolate(transfer.sourceCodeHint, {
                      send: copy.moveToDesktop,
                      create: transfer.createMoveCode,
                      receive: transfer.createReceiveCode,
                    })}
                  </p>
                  <CodeField value={code} onChange={setCode} label={transfer.sourceCodeLabel} />
                </div>
                <div
                  role="tabpanel"
                  id={`${receiveId}-panel-offer`}
                  aria-labelledby={`${receiveId}-tab-offer`}
                  hidden={receiveMethod !== "offer"}
                >
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {interpolate(transfer.receiveCodeHint, {
                      move: copy.moveToServer,
                      another: copy.moveToAnotherServer,
                      existing: transfer.existingInstance,
                    })}
                  </p>
                </div>
              </div>
            )}
            {action === "pair" && (
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.pairOwnDevice}</p>
            )}
            {action === "return" && (
              <p className="rounded-xl bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
                Jobs and incoming webhooks will depend on this computer being online. Your project
                containers keep running on their servers.
              </p>
            )}
            {generated && (
              <>
                <CodeField
                  label={
                    action === "pair"
                      ? transfer.connectionCode
                      : action === "send"
                        ? transfer.moveCode
                        : transfer.receiveCode
                  }
                  value={generated}
                  readOnly
                />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {action === "pair"
                    ? interpolate(transfer.connectionCodeHint, {
                        connect: copy.connectExisting,
                        useCode: t.settings.instance.connection.useCode,
                      })
                    : action === "send"
                      ? interpolate(transfer.moveCodeHint, {
                          more: copy.moreOptions,
                          receive: copy.receiveInstance,
                          paste: transfer.pasteMoveCode,
                        })
                      : interpolate(transfer.receiveCodeHint, {
                          move: copy.moveToServer,
                          another: copy.moveToAnotherServer,
                          existing: transfer.existingInstance,
                        })}
                </p>
                <p className="text-xs text-muted-foreground">{transfer.codeExpiry}</p>
              </>
            )}
            {needsConfirmation && !needsAccount && !generated && (
              <div className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
                <Checkbox
                  id={confirmationId}
                  checked={confirmed}
                  onCheckedChange={setConfirmed}
                  className="mt-1"
                />
                <label htmlFor={confirmationId}>
                  {action === "receive" || action === "return"
                    ? "Replace this instance’s data with the incoming instance. A recovery snapshot is saved first."
                    : action === "move" && destination === "existing"
                      ? transfer.replaceDestinationConfirmation
                      : "Move all workspaces, users and credentials, and pause changes during the handoff."}
                </label>
              </div>
            )}
            {error && (
              <p
                role="alert"
                className="whitespace-pre-line rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        </div>
        {!setupAccount && (
          <div className="flex shrink-0 justify-end gap-2 bg-muted/20 px-6 py-4">
            <Button variant="ghost" onClick={close} disabled={busy}>
              {generated ? "Done" : "Cancel"}
            </Button>
            {action === "return" && remoteHosts === null && error ? (
              <Button onClick={() => setSourceAttempt((attempt) => attempt + 1)}>
                {t.chrome.apiDown.retry}
              </Button>
            ) : (
              !generated && (
                <Button disabled={disabled} onClick={() => void submit()}>
                  {busy && <Icon name="spinner" className="animate-spin" />}
                  {needsAccount
                    ? copy.continueSetup
                    : action === "pair"
                      ? "Create connection code"
                      : action === "send"
                        ? transfer.createMoveCode
                        : action === "return"
                          ? "Move to Desktop"
                          : action === "receive" && receiveMethod === "offer"
                            ? transfer.createReceiveCode
                            : "Move instance"}
                </Button>
              )
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
