"use client";
import { useCallback, useEffect, useId, useState } from "react";
import type { IngressConnectInput } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import { credentialsApi } from "@/lib/api/credentials";
import { ingressApi } from "@/lib/api/ingress";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { useDialogFocus } from "@/hooks/useDialogFocus";
export function IngressConnectForm({
  serverId,
  onClose,
  onSaved,
  onBusyChange,
}: {
  serverId: string;
  onClose: () => void;
  onSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n(),
    copy = t.ingress,
    id = useId();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [editingCredential, setEditingCredential] = useState<string | null>(null);
  const { dialog, onKeyDown } = useDialogFocus(() => {
    if (!mutation.busy && !credentialBusy) onClose();
  });
  const held = useScopedResource(
    useCallback(async () => {
      const [p, c] = await Promise.all([credentialsApi.providers(), credentialsApi.list()]);
      return { providers: p.data, credentials: c.data.filter((c) => c.provider === "cloudflare") };
    }, []),
  );
  const [newCredential, setNewCredential] = useState(false),
    [credentialId, setCredentialId] = useState(""),
    [accountId, setAccountId] = useState(""),
    [tunnelId, setTunnelId] = useState(""),
    [name, setName] = useState("Openship"),
    [connector, setConnector] = useState<"existing" | "managed">("existing"),
    [defaultForDomains, setDefault] = useState(true),
    [protect, setProtect] = useState(false),
    [policyId, setPolicyId] = useState(""),
    [edgePort, setEdgePort] = useState("80");
  const discovery = useScopedResource(
    useCallback(
      () =>
        credentialId
          ? ingressApi.discover({
              credentialId,
              accountId: accountId || undefined,
              includePolicies: protect,
            })
          : Promise.resolve(null),
      [credentialId, accountId, protect],
    ),
  );
  const mutation = useScopedMutation();
  useEffect(() => {
    onBusyChange?.(mutation.busy || credentialBusy);
    return () => onBusyChange?.(false);
  }, [mutation.busy, credentialBusy, onBusyChange]);
  const provider = held.data?.providers.find((p) => p.id === "cloudflare");
  const selected = discovery.data?.tunnels.find((t) => t.id === tunnelId);
  const valid =
    credentialId &&
    accountId &&
    tunnelId &&
    (tunnelId !== "new" || name.trim()) &&
    (tunnelId === "new" || selected?.remote) &&
    (!protect || policyId) &&
    Number.isInteger(Number(edgePort)) &&
    Number(edgePort) > 0 &&
    Number(edgePort) < 65536;
  const field = (key: string, label: string, child: React.ReactNode) => (
    <div className="space-y-2">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
        {label}
      </label>
      {child}
    </div>
  );
  const select = (
    key: string,
    value: string,
    onChange: (value: string) => void,
    options: Array<{ value: string; label: string; description?: string }>,
    disabled = false,
  ) => (
    <CustomSelect
      id={`${id}-${key}`}
      variant="filled"
      triggerClassName="bg-muted/60 hover:bg-muted"
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      placeholder={copy.choose}
    />
  );
  async function submit() {
    if (!valid) return;
    const input: IngressConnectInput = {
      serverId,
      credentialId,
      accountId,
      name: tunnelId === "new" ? name.trim() : selected!.name.slice(0, 80),
      ...(tunnelId === "new" ? {} : { tunnelId }),
      connector,
      defaultForDomains,
      edgePort: Number(edgePort),
      ...(protect ? { defaultAccessPolicyId: policyId } : {}),
    };
    const result = await mutation.execute(() => ingressApi.connect(input));
    if (result) onSaved();
  }
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="p-6 space-y-5 outline-none"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            {copy.connect}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          disabled={mutation.busy || credentialBusy}
          aria-label={copy.close}
        >
          <Icon name="close" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{copy.permissions}</p>
      {held.loading ? (
        <div className="space-y-3 animate-pulse" aria-label={copy.loading}>
          <div className="h-12 rounded-xl bg-muted" />
          <div className="h-12 rounded-xl bg-muted" />
        </div>
      ) : held.error ? (
        <div role="alert" className="text-sm text-danger">
          {held.error}
          <Button variant="ghost" onClick={held.refresh}>
            {copy.refresh}
          </Button>
        </div>
      ) : newCredential && provider ? (
        <CredentialForm
          provider={provider}
          existing={held.data?.credentials.find((c) => c.id === editingCredential)}
          onBusyChange={setCredentialBusy}
          onCancel={() => setNewCredential(false)}
          onSaved={(c) => {
            setNewCredential(false);
            held.refresh();
            setCredentialId(c.id);
            setAccountId("");
            setTunnelId("");
          }}
        />
      ) : (
        <>
          {field(
            "credential",
            copy.credential,
            <CustomSelect
              id={`${id}-credential`}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
              value={credentialId}
              onChange={(v) => {
                setCredentialId(v);
                setAccountId("");
                setTunnelId("");
                setPolicyId("");
              }}
              options={(held.data?.credentials ?? []).map((c) => ({
                value: c.id,
                label: c.name,
                description: c.status === "invalid" ? copy.reconnect : undefined,
              }))}
              placeholder={copy.choose}
              footerAction={
                provider
                  ? {
                      label: copy.addCredential,
                      onClick: () => {
                        setEditingCredential(null);
                        setNewCredential(true);
                      },
                    }
                  : undefined
              }
            />,
          )}
          {held.data?.credentials.find((c) => c.id === credentialId)?.status === "invalid" && (
            <Button
              variant="secondary"
              onClick={() => {
                setEditingCredential(credentialId);
                setNewCredential(true);
              }}
            >
              {copy.reconnect}
            </Button>
          )}
          {credentialId && (
            <>
              {field(
                "account",
                copy.account,
                discovery.data?.accounts.length ? (
                  select(
                    "account",
                    accountId,
                    (v) => {
                      setAccountId(v);
                      setTunnelId("");
                      setPolicyId("");
                    },
                    discovery.data.accounts.map((a) => ({
                      value: a.id,
                      label: a.name,
                      description: a.id,
                    })),
                  )
                ) : (
                  <Input
                    id={`${id}-account`}
                    variant="filled"
                    value={accountId}
                    placeholder={copy.accountId}
                    onChange={(e) => {
                      setAccountId(e.target.value.trim());
                      setTunnelId("");
                      setPolicyId("");
                    }}
                  />
                ),
              )}
              {discovery.error ? (
                <p role="alert" className="text-sm text-danger">
                  {discovery.error}
                  <Button variant="ghost" onClick={discovery.refresh}>
                    {copy.refresh}
                  </Button>
                </p>
              ) : discovery.loading ? (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Icon name="spinner" className="size-4 animate-spin" />
                  {copy.loading}
                </p>
              ) : (
                accountId && (
                  <>
                    {field(
                      "tunnel",
                      copy.tunnel,
                      select(
                        "tunnel",
                        tunnelId,
                        (v) => {
                          setTunnelId(v);
                          if (v === "new") setConnector("managed");
                        },
                        [
                          { value: "new", label: copy.newTunnel },
                          ...(discovery.data?.tunnels ?? []).map((t) => ({
                            value: t.id,
                            label: t.name,
                            description: t.remote ? t.status : copy.localTunnel,
                          })),
                        ],
                      ),
                    )}
                    {selected && !selected.remote && (
                      <p role="alert" className="text-sm text-warning">
                        {copy.convertTunnel}
                      </p>
                    )}
                    {tunnelId === "new" &&
                      field(
                        "name",
                        copy.name,
                        <Input
                          id={`${id}-name`}
                          variant="filled"
                          value={name}
                          maxLength={80}
                          onChange={(e) => setName(e.target.value)}
                        />,
                      )}
                    {tunnelId &&
                      field(
                        "connector",
                        copy.connector,
                        select(
                          "connector",
                          connector,
                          (v) => setConnector(v as "existing" | "managed"),
                          [
                            {
                              value: "existing",
                              label: copy.existingConnector,
                              description: copy.existingConnectorHint,
                            },
                            {
                              value: "managed",
                              label: copy.installConnector,
                              description: copy.installConnectorHint,
                            },
                          ],
                        ),
                      )}
                    <div className="flex items-start justify-between gap-4 rounded-xl bg-card p-4">
                      <div>
                        <p className="text-sm font-medium">{copy.autoDomains}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{copy.autoDomainsHint}</p>
                      </div>
                      <Switch
                        checked={defaultForDomains}
                        onChange={setDefault}
                        ariaLabel={copy.autoDomains}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm font-medium">{copy.protect}</span>
                      <Switch
                        checked={protect}
                        onChange={(v) => {
                          setProtect(v);
                          setPolicyId("");
                        }}
                        ariaLabel={copy.protect}
                      />
                    </div>
                    {protect && (
                      <>
                        <p className="text-xs text-muted-foreground">{copy.protectHint}</p>
                        {discovery.data?.policiesError ? (
                          <p role="alert" className="text-sm text-danger">
                            {discovery.data.policiesError}
                            <Button variant="ghost" onClick={discovery.refresh}>
                              {copy.refresh}
                            </Button>
                          </p>
                        ) : (
                          field(
                            "policy",
                            copy.policy,
                            select(
                              "policy",
                              policyId,
                              setPolicyId,
                              (discovery.data?.policies ?? []).map((p) => ({
                                value: p.id,
                                label: p.name,
                                description: p.decision,
                              })),
                            ),
                          )
                        )}
                      </>
                    )}
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        {copy.advanced}
                      </summary>
                      <div className="mt-3">
                        {field(
                          "port",
                          copy.edgePort,
                          <Input
                            id={`${id}-port`}
                            variant="filled"
                            type="number"
                            min={1}
                            max={65535}
                            value={edgePort}
                            onChange={(e) => setEdgePort(e.target.value)}
                          />,
                        )}
                      </div>
                    </details>
                  </>
                )
              )}
            </>
          )}
          {mutation.error && (
            <p role="alert" className="text-sm text-danger">
              {mutation.error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="flex-1 text-xs text-muted-foreground">
              {valid ? copy.review : copy.completeFields}
            </p>
            <Button onClick={() => void submit()} disabled={!valid || mutation.busy}>
              {mutation.busy ? (
                <Icon name="spinner" className="animate-spin" />
              ) : (
                <Icon name="plug" />
              )}
              {copy.connect}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
