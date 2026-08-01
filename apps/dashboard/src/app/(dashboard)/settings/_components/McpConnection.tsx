"use client";

/**
 * MCP connection card. Shows the JSON-RPC endpoint for the current runtime
 * target. Primary path is OAuth (clients discover + authorize in the browser);
 * a Personal Access Token is the fallback for clients without OAuth.
 */

import { useEffect, useState, type ComponentType } from "react";
import Link from "next/link";
import { Boxes, Copy, Check, ShieldCheck, Unplug, Loader2, ChevronDown, ExternalLink, KeyRound } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { getRestApiBaseUrl } from "@/lib/api/urls";
import { tokensApi, getApiErrorMessage, type McpClient } from "@/lib/api";
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
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
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
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? t.settings.common.copied : t.settings.common.copy}
      </button>
    </div>
  );
}

/** Official client brand marks (single-path SVGs from the simple-icons set).
 *  Monochrome via currentColor so they stay legible in both chip states. */
function brandIcon(path: string): ComponentType<{ className?: string }> {
  return function BrandIcon({ className }: { className?: string }) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d={path} />
      </svg>
    );
  };
}

const ClaudeLogo = brandIcon(
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
);
const CursorLogo = brandIcon(
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
);
const WindsurfLogo = brandIcon(
  "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z",
);
const ZedLogo = brandIcon(
  "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
);
const OpenAiLogo = brandIcon(
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
);
const CopilotLogo = brandIcon(
  "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z",
);

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
  Icon: ComponentType<{ className?: string }>;
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
    Icon: ClaudeLogo,
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
    Icon: OpenAiLogo,
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
    Icon: CursorLogo,
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
    Icon: CopilotLogo,
    setup: (e) => ({
      label: "Run once to register the server",
      code: `code --add-mcp '{"name":"openship","type":"http","url":"${e}"}'`,
      note: 'Runs through GitHub Copilot. Or add it under "servers" in .vscode/mcp.json.',
    }),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    Icon: ClaudeLogo,
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
    Icon: WindsurfLogo,
    setup: (e) => ({
      label: "Add to ~/.codeium/windsurf/mcp_config.json",
      code: JSON.stringify({ mcpServers: { openship: { serverUrl: e } } }, null, 2),
    }),
  },
  {
    id: "zed",
    name: "Zed",
    Icon: ZedLogo,
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
    Icon: Boxes,
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
              <c.Icon className="size-4" />
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
            <ExternalLink className="size-3.5" />
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

  // Resolve on the client — getRestApiBaseUrl reads window.location, so compute
  // after mount to avoid an SSR/hydration mismatch.
  const [endpoint, setEndpoint] = useState("");
  useEffect(() => {
    setEndpoint(`${getRestApiBaseUrl()}/mcp`);
  }, []);

  // Connected clients own the layout: once anything is connected the list leads
  // and the how-to collapses behind "Connect another client". Fetch lives here
  // (not in a child) so the list + guide render in one coherent pass — no
  // expanded-then-collapse flash for users who do have connections.
  const [clients, setClients] = useState<McpClient[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

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
      icon={Boxes}
      title={t.settings.mcp.title}
      description={t.settings.mcp.description}
      iconBg="bg-success-bg"
      iconColor="text-success"
    >
      <div className="space-y-4">
        {clients === null ? (
          <div className="flex items-center gap-2 rounded-xl border border-border/50 px-4 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t.settings.mcp.loading}
          </div>
        ) : hasClients ? (
          <>
            <ClientsList
              clients={clients}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              disconnecting={disconnecting}
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
                  <ShieldCheck className="size-4 text-success" />
                  {t.settings.mcp.connectAnother}
                </span>
                <ChevronDown
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
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
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
          <ModeTab active={authMode === "oauth"} onClick={() => setAuthMode("oauth")} Icon={ShieldCheck} label={t.settings.mcp.oauth} />
          <ModeTab
            active={authMode === "token"}
            onClick={() => setAuthMode("token")}
            Icon={KeyRound}
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
  Icon: ComponentType<{ className?: string }>;
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
      <Icon className="size-3.5" />
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
  onDisconnect,
}: {
  clients: McpClient[];
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
  disconnecting: string | null;
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
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                    {t.settings.common.disconnect}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmId(id)}
                  disabled={!id}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
                >
                  <Unplug className="size-3.5" />
                  {t.settings.common.disconnect}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
