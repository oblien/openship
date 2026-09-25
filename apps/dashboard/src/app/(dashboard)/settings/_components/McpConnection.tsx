"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * MCP connection card. Shows the JSON-RPC endpoint for the current runtime
 * target. Primary path is OAuth (clients discover + authorize in the browser);
 * a Personal Access Token is the fallback for clients without OAuth.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { SettingsSection } from "./SettingsSection";
import { McpAccessEditor } from "./McpAccessEditor";
import { getMcpEndpointUrl } from "@/lib/api/urls";
import { tokensApi, getApiErrorMessage, type McpClient, type McpClientDetail } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };
  return { copied, copy };
}

function CopyRow({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
        {value || "…"}
      </code>
      <button
        onClick={() => copy(value)}
        disabled={!value}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
      >
        {copied ? <UiIcon name="check" className="size-3.5" /> : <UiIcon name="copy" className="size-3.5" />}
        {copied ? t.settings.common.copied : t.settings.common.copy}
      </button>
    </div>
  );
}

function CopyBlock({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  const { t } = useI18n();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-3 pe-16 font-mono text-xs leading-relaxed text-foreground">
        {value}
      </pre>
      <button
        onClick={() => copy(value)}
        className="absolute end-2 top-2 inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
      >
        {copied ? <UiIcon name="check" className="size-3.5" /> : <UiIcon name="copy" className="size-3.5" />}
        {copied ? t.settings.common.copied : t.settings.common.copy}
      </button>
    </div>
  );
}

/** Per-client "add MCP" recipe. Either a copyable command/config, or numbered
 *  steps (for clients configured through their own UI). `deeplink` adds a
 *  one-click install button where the client supports it. */
type ClientSetup = {
  label: string;
  code?: string;
  steps?: string[];
  note?: string;
  deeplink?: string;
  deeplinkLabel?: string;
};

interface McpClientDef {
  id: string;
  name: string;
  Icon: IconName;
  setup: (endpoint: string) => ClientSetup;
}

/** base64 of a small JSON config, for clients that take an install deeplink. */
function encodeConfig(obj: unknown): string {
  try {
    return encodeURIComponent(btoa(JSON.stringify(obj)));
  } catch {
    return "";
  }
}

/** How each MCP client adds a remote HTTP server. Auth is OAuth for all of
 *  them — the client opens the browser to authorize on first connect. */
const MCP_CLIENTS: McpClientDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    Icon: "claude",
    setup: (e) => ({
      label: "Run in your terminal",
      code: `claude mcp add --transport http openship ${e}`,
      note: "Claude Code opens your browser to authorize on first use.",
    }),
  },
  {
    // Codex sits next to Claude Code: both are terminal-native, both take a
    // `<tool> mcp add` subcommand, so the two CLI recipes read together.
    id: "codex",
    name: "Codex",
    Icon: "openai",
    setup: (e) => ({
      label: "Run in your terminal",
      // Two steps, one block: `mcp add` registers the server, `mcp login` runs
      // the OAuth handshake. Unlike the other CLIs here, Codex does NOT open the
      // browser on first tool call — without the login step the server is
      // registered but every call is unauthorized.
      code: `codex mcp add openship --url ${e}\ncodex mcp login openship`,
      note:
        "Local Codex surfaces (CLI, desktop app, IDE extension) share one MCP config, so this " +
        "registers Openship for all of them — restart any that were already running. Hosted " +
        "Codex tasks are separate: they only reach this endpoint if that environment can.",
    }),
  },
  {
    id: "cursor",
    name: "Cursor",
    Icon: "cursor",
    setup: (e) => ({
      label: "Add to ~/.cursor/mcp.json",
      code: JSON.stringify({ mcpServers: { openship: { url: e } } }, null, 2),
      deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=openship&config=${encodeConfig({ url: e })}`,
      deeplinkLabel: "Add to Cursor",
      note: "Restart Cursor after saving; it authorizes in the browser.",
    }),
  },
  {
    id: "vscode",
    name: "VS Code",
    Icon: "copilot",
    setup: (e) => ({
      label: "Run once to register the server",
      code: `code --add-mcp '{"name":"openship","type":"http","url":"${e}"}'`,
      note: 'Runs through GitHub Copilot. Or add it under "servers" in .vscode/mcp.json.',
    }),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    Icon: "claude",
    setup: () => ({
      label: "Add a custom connector",
      steps: [
        "Settings → Connectors → Add custom connector",
        "Paste the endpoint below as the connector URL",
        "Approve access in the browser window that opens",
      ],
      note: "Requires a Claude plan with custom connectors.",
    }),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    Icon: "windsurf",
    setup: (e) => ({
      label: "Add to ~/.codeium/windsurf/mcp_config.json",
      code: JSON.stringify({ mcpServers: { openship: { serverUrl: e } } }, null, 2),
    }),
  },
  {
    id: "zed",
    name: "Zed",
    Icon: "zed",
    setup: (e) => ({
      label: "Add to Zed settings.json",
      code: JSON.stringify(
        {
          context_servers: {
            openship: { source: "custom", command: { path: "npx", args: ["-y", "mcp-remote", e] } },
          },
        },
        null,
        2,
      ),
      note: "Bridges the remote server via mcp-remote; authorizes in the browser.",
    }),
  },
  {
    id: "other",
    name: "Other",
    Icon: "mcp",
    setup: (e) => ({
      label: "Generic MCP client config",
      code: JSON.stringify({ mcpServers: { openship: { url: e } } }, null, 2),
      note: "Most MCP clients accept a { mcpServers: { <name>: { url } } } block.",
    }),
  },
];

/** Client picker: pick your agent, get the exact command/config to add Openship,
 *  pre-filled with this instance's endpoint. */
function McpClientSetup({ endpoint }: { endpoint: string }) {
  const { t } = useI18n();
  const [activeId, setActiveId] = useState(MCP_CLIENTS[0].id);
  const active = MCP_CLIENTS.find((c) => c.id === activeId) ?? MCP_CLIENTS[0];
  const setup = active.setup(endpoint || "https://<your-openship>/api/mcp");

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-foreground">{t.settings.mcp.addToClient}</p>

      {/* Client selector */}
      <div className="flex flex-wrap gap-1.5">
        {MCP_CLIENTS.map((c) => {
          const selected = c.id === activeId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveId(c.id)}
              aria-pressed={selected}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "border-success/50 bg-success/10 text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-muted/40"
              }`}
            >
              <UiIcon name={c.Icon} className="size-4" />
              {c.name}
            </button>
          );
        })}
      </div>

      {/* Selected client's recipe */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">{setup.label}</p>
        {setup.steps ? (
          <ol className="list-decimal space-y-1 rounded-lg border border-border/50 bg-muted/20 py-3 ps-8 pe-4 text-xs text-muted-foreground">
            {setup.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        ) : setup.code ? (
          <CopyBlock value={setup.code} />
        ) : null}

        {setup.deeplink && (
          <a
            href={setup.deeplink}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <UiIcon name="external-link" className="size-3.5" />
            {setup.deeplinkLabel ?? t.settings.mcp.install}
          </a>
        )}

        {setup.note && <p className="mt-1.5 text-xs text-muted-foreground">{setup.note}</p>}
      </div>

      {/* Canonical endpoint — needed by the UI-configured clients + as a copy source. */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">{t.settings.mcp.endpoint}</p>
        <CopyRow value={endpoint} />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t.settings.mcp.endpointNote}
        </p>
      </div>
    </div>
  );
}

export function McpConnection() {
  const { showToast } = useToast();
  const { t } = useI18n();

  // Resolve on the client — getMcpEndpointUrl reads window.location, so compute
  // after mount to avoid an SSR/hydration mismatch.
  const [endpoint, setEndpoint] = useState("");
  useEffect(() => {
    setEndpoint(getMcpEndpointUrl());
  }, []);

  // Connected clients own the layout: once anything is connected the list leads
  // and the how-to collapses behind "Connect another client". Fetch lives here
  // (not in a child) so the list + guide render in one coherent pass — no
  // expanded-then-collapse flash for users who do have connections.
  const [clients, setClients] = useState<McpClient[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  /** Which row is loading its scope, and the loaded detail once it arrives. */
  const [loadingScope, setLoadingScope] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpClientDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    tokensApi
      .listMcpClients()
      .then((res) => !cancelled && setClients(res.data ?? []))
      .catch(() => !cancelled && setClients([]));
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * FETCH BEFORE OPEN. The editor is only mounted once the current scope is in hand,
   * because saving replaces grants wholesale — a panel that opened un-prefilled and
   * was saved would overwrite whatever the user had. On failure we toast and open
   * NOTHING, so the failure is visible instead of silently destructive.
   */
  const openEditor = async (clientId: string) => {
    setLoadingScope(clientId);
    try {
      const res = await tokensApi.getMcpClient(clientId);
      if (!res.data) throw new Error("empty response");
      setEditing(res.data);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.mcp.loadScopeFailed), "error");
    } finally {
      setLoadingScope(null);
    }
  };

  /** Refetch the row so its grantCount pill can't drift from what was just saved. */
  const afterSave = async () => {
    setEditing(null);
    try {
      const res = await tokensApi.listMcpClients();
      setClients(res.data ?? []);
    } catch {
      /* the save succeeded; a stale count is cosmetic and self-heals on reload */
    }
  };

  const disconnect = async (clientId: string) => {
    setDisconnecting(clientId);
    try {
      await tokensApi.disconnectMcpClient(clientId);
      setClients((prev) => (prev ?? []).filter((c) => c.clientId !== clientId));
      showToast(t.settings.mcp.toast.disconnected, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.mcp.toast.disconnectFailed), "error", t.settings.common.toast.disconnect);
    } finally {
      setDisconnecting(null);
      setConfirmId(null);
    }
  };

  const hasClients = (clients?.length ?? 0) > 0;

  const configSnippet = [
    "{",
    '  "mcpServers": {',
    '    "openship": {',
    `      "url": "${endpoint || "https://<your-openship>/api/mcp"}",`,
    '      "headers": { "Authorization": "Bearer opsh_pat_…" }',
    "    }",
    "  }",
    "}",
  ].join("\n");

  return (
    <SettingsSection
      icon={"mcp"}
      title={t.settings.mcp.title}
      description={t.settings.mcp.description}
      iconBg="bg-success-bg"
      iconColor="text-success"
    >
      <div className="space-y-4">
        {clients === null ? (
          <div className="flex items-center gap-2 rounded-xl border border-border/50 px-4 py-3 text-xs text-muted-foreground">
            <UiIcon name="spinner" className="size-3.5 animate-spin" /> {t.settings.mcp.loading}
          </div>
        ) : editing ? (
          <McpAccessEditor
            detail={editing}
            onClose={() => setEditing(null)}
            onSaved={() => void afterSave()}
          />
        ) : hasClients ? (
          <>
            <ClientsList
              clients={clients}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              disconnecting={disconnecting}
              loadingScope={loadingScope}
              onEdit={(id) => void openEditor(id)}
              onDisconnect={disconnect}
            />

            {/* Once something is connected, the how-to collapses out of the way. */}
            <div className="rounded-xl border border-border/50">
              <button
                type="button"
                onClick={() => setGuideOpen((o) => !o)}
                className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-start transition-colors hover:bg-muted/20"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <UiIcon name="shield-check" className="size-4 text-success" />
                  {t.settings.mcp.connectAnother}
                </span>
                <UiIcon name="chevron-down"
                  className={`size-4 text-muted-foreground transition-transform ${guideOpen ? "rotate-180" : ""}`}
                />
              </button>
              {guideOpen && (
                <div className="space-y-4 border-t border-border/40 px-4 py-4">
                  <GuideBody endpoint={endpoint} configSnippet={configSnippet} />
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Nothing connected yet — lead with the how-to + explainer banner. */}
            <div className="flex gap-2.5 rounded-xl border border-success-border bg-success-bg p-3">
              <UiIcon name="shield-check" className="mt-0.5 size-4 shrink-0 text-success" />
              <div className="text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">{t.settings.mcp.bannerStrong}</span>{" "}
                {t.settings.mcp.bannerRest}
              </div>
            </div>
            <GuideBody endpoint={endpoint} configSnippet={configSnippet} />
          </>
        )}
      </div>
    </SettingsSection>
  );
}

/** The connection how-to. A toggle picks OAuth (browser authorize) or a static
 *  token, so the two config shapes ({ url } vs { url, headers }) are never shown
 *  together and can't be mixed by mistake. Shared by the onboarding (nothing
 *  connected) and the collapsible "connect another" paths. */
function GuideBody({ endpoint, configSnippet }: { endpoint: string; configSnippet: string }) {
  const { t } = useI18n();
  const [authMode, setAuthMode] = useState<"oauth" | "token">("oauth");

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">{t.settings.mcp.authentication}</p>
        <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5">
          <ModeTab active={authMode === "oauth"} onClick={() => setAuthMode("oauth")} Icon={"shield-check"} label={t.settings.mcp.oauth} />
          <ModeTab
            active={authMode === "token"}
            onClick={() => setAuthMode("token")}
            Icon={"key"}
            label={t.settings.mcp.staticToken}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {authMode === "oauth"
            ? t.settings.mcp.oauthNote
            : t.settings.mcp.tokenNote}
        </p>
      </div>

      {authMode === "oauth" ? (
        <McpClientSetup endpoint={endpoint} />
      ) : (
        <StaticTokenSetup endpoint={endpoint} configSnippet={configSnippet} />
      )}
    </div>
  );
}

/** One segment of the OAuth / static-token toggle. */
function ModeTab({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: IconName;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <UiIcon name={Icon} className="size-3.5" />
      {label}
    </button>
  );
}

/** Static-token path: the { url, headers } config + a pointer to mint a token. */
function StaticTokenSetup({ endpoint, configSnippet }: { endpoint: string; configSnippet: string }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">{t.settings.mcp.clientConfig}</p>
        <CopyBlock value={configSnippet} />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t.settings.mcp.createTokenPrefix}{" "}
          <Link
            href="/settings?tab=tokens"
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
          >
            {t.settings.mcp.tokensTab}
          </Link>{" "}
          {t.settings.mcp.createTokenMid} <code className="font-mono">opsh_pat_…</code>{t.settings.mcp.createTokenSuffix}
        </p>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">{t.settings.mcp.endpoint}</p>
        <CopyRow value={endpoint} />
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Presentational list of connected MCP clients (OAuth bindings) with a
 * two-step disconnect. State lives in the parent so the list + how-to render
 * coherently. Disconnect revokes the client's tokens server-side.
 */
function ClientsList({
  clients,
  confirmId,
  setConfirmId,
  disconnecting,
  loadingScope,
  onEdit,
  onDisconnect,
}: {
  clients: McpClient[];
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
  disconnecting: string | null;
  loadingScope: string | null;
  onEdit: (clientId: string) => void;
  onDisconnect: (clientId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-foreground">{t.settings.mcp.connectedClients}</p>
      <div className="divide-y divide-border/40 rounded-xl border border-border/50">
        {clients.map((c) => {
          const id = c.clientId ?? "";
          const confirming = confirmId === id;
          const busy = disconnecting === id;
          return (
            <div key={id || c.name} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      c.readOnly
                        ? "bg-muted text-muted-foreground"
                        : "bg-success-bg text-success"
                    }`}
                  >
                    {c.readOnly ? t.settings.mcp.clientReadOnly : t.settings.mcp.clientFullControl}
                  </span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {c.scoped
                      ? interpolate(
                          c.grantCount === 1 ? t.settings.mcp.resourcesOne : t.settings.mcp.resourcesMany,
                          { count: String(c.grantCount) },
                        )
                      : t.settings.mcp.allResources}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {c.organizationName ? interpolate(t.settings.mcp.orgPrefix, { org: c.organizationName }) : ""}
                  {interpolate(t.settings.mcp.authorized, { date: formatDate(c.authorizedAt) })}
                  {c.lastUsedAt ? interpolate(t.settings.mcp.lastUsedSuffix, { date: formatDate(c.lastUsedAt) }) : ""}
                  {/* A timestamp says the agent is alive; the count says how much
                      it has actually done, which is the difference between a client
                      someone tried once and one running unattended all week. */}
                  {c.useCount > 0
                    ? interpolate(
                        c.useCount === 1 ? t.settings.mcp.callsOne : t.settings.mcp.callsMany,
                        { count: c.useCount.toLocaleString() },
                      )
                    : ""}
                </p>
              </div>
              {confirming ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => setConfirmId(null)}
                    disabled={busy}
                    className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {t.settings.common.cancel}
                  </button>
                  <button
                    onClick={() => onDisconnect(id)}
                    disabled={busy || !id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-danger-solid px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-danger-solid/90 disabled:opacity-50"
                  >
                    {busy ? <UiIcon name="spinner" className="size-3.5 animate-spin" /> : <UiIcon name="unplug" className="size-3.5" />}
                    {t.settings.common.disconnect}
                  </button>
                </div>
              ) : (
                // Edit leads; Disconnect keeps its danger hover. Both are hidden while
                // the row is confirming a disconnect — that interaction owns the row.
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Straight to this agent's own history. The audit log could
                      already filter to "an AI assistant", but arriving from the
                      row that names one and having to re-pick it was the gap. */}
                  <Link
                    href={`/audit?source=mcp&client=${encodeURIComponent(c.auditClientId)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    <UiIcon name="file-text" className="size-3.5" />
                    {t.settings.mcp.viewActivity}
                  </Link>
                  <button
                    onClick={() => onEdit(id)}
                    disabled={!id || loadingScope === id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                  >
                    {loadingScope === id ? (
                      <UiIcon name="spinner" className="size-3.5 animate-spin" />
                    ) : (
                      <UiIcon name="sliders" className="size-3.5" />
                    )}
                    {t.settings.mcp.editAccess}
                  </button>
                  <button
                    onClick={() => setConfirmId(id)}
                    disabled={!id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
                  >
                    <UiIcon name="unplug" className="size-3.5" />
                    {t.settings.common.disconnect}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
