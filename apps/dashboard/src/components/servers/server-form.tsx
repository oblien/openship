"use client";

import { useEffect, useRef, useState } from "react";
import {
  Server,
  Loader2,
  Check,
  FolderOpen,
  KeyRound,
  Lock,
  ChevronDown,
  Network,
  X,
  ClipboardPaste,
  Upload,
  Eye,
  EyeOff,
} from "lucide-react";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ServerInfo, SshProbeInput } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";

const INPUT =
  "w-full px-3.5 py-2.5 rounded-xl border border-border/50 bg-muted/30 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all focus:ring-2 focus:ring-primary/20";

const LABEL = "block text-sm font-medium text-muted-foreground mb-1.5";

interface ServerFormProps {
  /** Truthy => edit mode (prefill + PATCH); otherwise create mode (POST). */
  server?: ServerInfo | null;
  /** Called after a successful save with the saved server and the mode used. */
  onSaved: (result: { server: ServerInfo; isEditing: boolean }) => void;
  /** Optional override for the primary button label. */
  submitLabel?: string;
  /**
   * Chrome only — the fields, validation and API calls are identical.
   * "page" is the self-contained card the /servers routes render; "modal" adds
   * a close button, scrolls the body, and pins the actions to a footer.
   */
  variant?: "page" | "modal";
  /** Renders the modal variant's close button. Ignored by the page variant. */
  onCancel?: () => void;
}

// The one SSH-credentials form: /servers/new, /servers/[serverId]?edit=true, and
// the add-server modal opened from every flow that needs a server. Field state,
// validation and the test/save calls live here exactly once - only the chrome
// differs (see `variant`). The surrounding page header and sidebars stay in the
// pages.
export function ServerForm({
  server,
  onSaved,
  submitLabel,
  variant = "page",
  onCancel,
}: ServerFormProps) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const { deployMode } = usePlatform();
  const isEditing = !!server;

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [serverName, setServerName] = useState(server?.name ?? "");
  const [sshHost, setSshHost] = useState(server?.sshHost ?? "");
  const [sshPort, setSshPort] = useState(String(server?.sshPort ?? 22));
  const [sshUser, setSshUser] = useState(server?.sshUser ?? "root");
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key" | "agent">(
    server?.sshAuthMethod === "key"
      ? "key"
      : server?.sshAuthMethod === "agent"
        ? "agent"
        : "password",
  );
  const [sshPassword, setSshPassword] = useState("");
  const [showSshPassword, setShowSshPassword] = useState(false);
  const [sshKeyPath, setSshKeyPath] = useState(server?.sshKeyPath ?? "");
  // Pasted / uploaded private-key material. Held only in component state and
  // sent on save/test; never prefilled (the API never returns key material).
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  // Which SSH-key sub-mode: paste the key into the browser, or point at a file
  // on the API host. A row that already stores a host path opens in "path";
  // everything else (incl. a stored pasted key, and fresh forms) opens in
  // "paste" — the right default for a remote instance where the key isn't here.
  const [sshKeyMode, setSshKeyMode] = useState<"paste" | "path">(
    server?.sshKeyPath ? "path" : "paste",
  );
  /**
   * Is a host path even a coherent answer here?
   *
   * Only where the browser and the API read the same filesystem — the desktop
   * shell. Everywhere else the path is resolved by `readFileSync` inside the API
   * process (apps/api/src/lib/ssh-manager.ts), and on a compose install that
   * process is a container whose volume list carries the docker socket, the edge
   * tree and the host-channel key — no `~/.ssh` (apps/cli/src/lib/compose.ts).
   * So `/root/.ssh/id_ed25519` typed on a VPS resolves in the container, finds
   * nothing, and buildSshConfig returns null: "Invalid auth configuration" for a
   * key the operator can `cat` on the host.
   *
   * A row that ALREADY stores a path keeps the toggle regardless of mode. Hiding
   * it would drop such a row into paste mode, where a save sends
   * `sshKeyPath: null` with no material to replace it — a rename would silently
   * strip the only credential the server has.
   */
  const pathModeOffered = deployMode === "desktop" || !!server?.sshKeyPath;
  /** The mode actually in force — `sshKeyMode` is only meaningful when offered. */
  const keyMode: "paste" | "path" = pathModeOffered ? sshKeyMode : "paste";
  // Whether the server already has an encrypted pasted key stored. Lets edit mode
  // say "a key is stored — paste to replace" and skip the require-a-key check.
  const hasStoredKey = !!server?.hasStoredKeyMaterial;
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const keyFileInputRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(
    !!(server?.sshJumpHost || server?.sshArgs),
  );
  const [jumpHost, setJumpHost] = useState(server?.sshJumpHost ?? "");
  const [extraArgs, setExtraArgs] = useState(server?.sshArgs ?? "");

  // A key file is only pickable where the API reads it from — this machine, i.e.
  // the desktop shell. On a remote instance the key lives on that host, so the
  // path stays typed and no button is offered. Detected AFTER mount: reading
  // window.desktop during render is an SSR/hydration mismatch.
  const [canBrowseKey, setCanBrowseKey] = useState(false);
  useEffect(() => {
    setCanBrowseKey(systemApi.hasNativeFilePicker());
  }, []);

  async function handleBrowseKey() {
    const picked = await systemApi.pickSshKeyFile();
    if (picked) setSshKeyPath(picked);
  }

  // Read a local key file's TEXT client-side and drop it into the paste box.
  // Works in any browser (no host round-trip, unlike the desktop path picker).
  const MAX_KEY_BYTES = 64 * 1024;
  async function handleKeyFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires onChange again.
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_KEY_BYTES) {
      showToast(t.servers.form.keyPasteInvalid, "error", t.servers.toastTitles.server);
      return;
    }
    const contents = await file.text();
    // Catch the common slip of picking a .pub or the wrong file. A private key
    // is a PEM/OpenSSH block; the server does the real validation on connect.
    if (!/-----BEGIN [^-]*PRIVATE KEY-----/.test(contents)) {
      showToast(t.servers.form.keyPasteInvalid, "error", t.servers.toastTitles.server);
      return;
    }
    setSshPrivateKey(contents);
  }

  async function handleSave() {
    if (!sshHost.trim()) {
      showToast(t.servers.form.toastIpRequired, "error", t.servers.toastTitles.server);
      return;
    }

    const currentPort = parseInt(sshPort, 10) || 22;
    const trimmedServerName = serverName.trim();
    const trimmedHost = sshHost.trim();
    const trimmedUser = sshUser.trim() || "root";
    const trimmedJumpHost = jumpHost.trim();
    const trimmedExtraArgs = extraArgs.trim();

    // When editing and not switching auth method, the stored secret is reused -
    // so a blank password/key is only an error on create or when switching.
    if (sshAuthMethod === "password" && (!isEditing || server?.sshAuthMethod !== "password") && !sshPassword) {
      showToast(t.servers.form.toastPasswordSwitchRequired, "error", t.servers.toastTitles.server);
      return;
    }

    if (sshAuthMethod === "key") {
      if (keyMode === "paste") {
        // Pasted material is required unless we're editing a server that already
        // has a key stored (blank = keep the stored one).
        if (!sshPrivateKey.trim() && !hasStoredKey) {
          showToast(t.servers.form.toastKeyRequired, "error", t.servers.toastTitles.server);
          return;
        }
      } else if ((!isEditing || server?.sshAuthMethod !== "key") && !sshKeyPath) {
        showToast(t.servers.form.toastKeyPathSwitchRequired, "error", t.servers.toastTitles.server);
        return;
      }
    }

    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        name: trimmedServerName || null,
        sshHost: trimmedHost,
        sshPort: currentPort,
        sshUser: trimmedUser,
        sshAuthMethod,
        sshJumpHost: trimmedJumpHost || null,
        sshArgs: trimmedExtraArgs || null,
      };


      if (sshAuthMethod === "password" && sshPassword) {
        data.sshPassword = sshPassword;
      }
      if (sshAuthMethod === "key") {
        if (keyMode === "paste") {
          // Only send material when the user actually typed/uploaded one — an
          // empty value would WIPE the stored key. Clear any stale host path.
          if (sshPrivateKey.trim()) data.sshPrivateKey = sshPrivateKey;
          data.sshKeyPath = null;
        } else {
          if (sshKeyPath) data.sshKeyPath = sshKeyPath;
          // Switching to a host path drops any previously stored pasted key.
          data.sshPrivateKey = null;
        }
        if (sshKeyPassphrase) data.sshKeyPassphrase = sshKeyPassphrase;
      }

      const saved = isEditing
        ? await systemApi.updateServerEntry(server!.id, data)
        : await systemApi.createServerEntry(data);

      showToast(isEditing ? t.servers.form.toastUpdated : t.servers.form.toastSaved, "success", t.servers.toastTitles.server);
      onSaved({ server: saved, isEditing });
    } catch (err) {
      showToast(
        getApiErrorMessage(err, t.servers.form.toastSaveFailed),
        "error",
        t.servers.toastTitles.server,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!sshHost.trim()) {
      showToast(t.servers.form.toastIpRequired, "error", t.servers.toastTitles.server);
      return;
    }

    if (sshAuthMethod === "password" && !sshPassword && !(isEditing && server?.sshAuthMethod === "password")) {
      showToast(t.servers.form.toastPasswordTestRequired, "error", t.servers.toastTitles.server);
      return;
    }

    if (sshAuthMethod === "key") {
      if (keyMode === "paste") {
        // A stored key can't be tested — the client never receives it — so a
        // paste-mode test always needs freshly entered material.
        if (!sshPrivateKey.trim()) {
          showToast(t.servers.form.toastKeyRequired, "error", t.servers.toastTitles.server);
          return;
        }
      } else if (!sshKeyPath && !(isEditing && server?.sshAuthMethod === "key")) {
        showToast(t.servers.form.toastKeyPathTestRequired, "error", t.servers.toastTitles.server);
        return;
      }
    }

    setTesting(true);
    setTestResult(null);
    try {
      const payload: SshProbeInput = {
        sshHost: sshHost.trim(),
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || "root",
        sshAuthMethod,
      };
      if (sshAuthMethod === "password" && sshPassword) {
        payload.sshPassword = sshPassword;
      }
      if (sshAuthMethod === "key") {
        if (keyMode === "paste") {
          if (sshPrivateKey.trim()) payload.sshPrivateKey = sshPrivateKey;
        } else if (sshKeyPath) {
          payload.sshKeyPath = sshKeyPath;
        }
        if (sshKeyPassphrase) payload.sshKeyPassphrase = sshKeyPassphrase;
      }
      // Same route the save will dial. Omitting these tested DIRECT reachability
      // for a host only reachable through a bastion — a red "Test connection" on
      // a configuration that works.
      if (jumpHost.trim()) payload.sshJumpHost = jumpHost.trim();
      if (extraArgs.trim()) payload.sshArgs = extraArgs.trim();

      const result = await systemApi.testConnection(payload);
      setTestResult(result);
      if (result.ok) {
        showToast(t.servers.form.toastConnectionSuccess, "success", t.servers.toastTitles.server);
      } else {
        showToast(result.message || t.servers.form.toastConnectionFailed, "error", t.servers.toastTitles.server);
      }
    } catch (err) {
      const message = getApiErrorMessage(err, t.servers.form.toastConnectionTestFailed);
      setTestResult({ ok: false, message });
      showToast(message, "error", t.servers.toastTitles.server);
    } finally {
      setTesting(false);
    }
  }

  const isModal = variant === "modal";

  // "Save & Continue to Setup" only fits /servers/new, which really does
  // continue to the install step; the modal saves and hands the row back.
  const defaultSubmit = isEditing
    ? t.servers.form.saveChanges
    : isModal
      ? t.servers.form.saveServer
      : t.servers.form.saveAndContinue;

  const actions = (
    <>
      <button
        type="button"
        onClick={handleTestConnection}
        disabled={testing || saving || !sshHost.trim()}
        className={`w-full inline-flex items-center justify-center gap-2 px-4 border border-border/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
          isModal ? "py-2.5 bg-card" : "py-3 bg-muted/30"
        }`}
      >
        {testing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : testResult?.ok ? (
          <Check className="size-4 text-success" />
        ) : (
          <Network className="size-4" />
        )}
        {testing ? t.servers.form.testing : testResult?.ok ? t.servers.form.connected : t.servers.form.testConnection}
      </button>
      {testResult && !testResult.ok && (
        <p className="text-xs text-danger text-center">{testResult.message}</p>
      )}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !sshHost.trim()}
        className={`w-full inline-flex items-center justify-center gap-2 px-4 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed ${
          isModal ? "py-2.5" : "py-3"
        }`}
      >
        {saving ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Check className="size-4" />
        )}
        {saving && isModal ? t.servers.form.savingServer : (submitLabel ?? defaultSubmit)}
      </button>
    </>
  );

  return (
    <div
      className={
        isModal
          ? "rounded-2xl overflow-hidden border border-border/50"
          : "bg-card rounded-2xl border border-border/50"
      }
      // In a modal the panel floats over a scrim, so it needs the opaque card
      // token - themes whose --card is translucent would bleed the page through.
      style={isModal ? { backgroundColor: "var(--th-card-bg-solid, var(--card))" } : undefined}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 bg-info-bg rounded-xl flex items-center justify-center shrink-0">
            <Server className="size-[18px] text-info" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-foreground text-[15px] truncate">
              {isModal ? t.servers.form.modalTitle : t.servers.form.sshConnection}
            </h2>
            <p className="text-xs text-muted-foreground truncate">
              {isModal ? t.servers.form.modalSubtitle : t.servers.form.sshConnectionDesc}
            </p>
          </div>
        </div>
        {isModal && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors disabled:opacity-50 shrink-0"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        )}
      </div>

      <div className={`p-5 space-y-[18px] ${isModal ? "max-h-[70vh] overflow-y-auto" : ""}`}>
        <div>
          <label className={LABEL}>{t.servers.form.serverName}</label>
          <input
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder={sshHost.trim() || t.servers.form.serverNamePlaceholder}
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
          />
          <p className="text-xs text-muted-foreground/60 mt-1.5">
            {t.servers.form.serverNameHelp}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
          <div>
            <label className={LABEL}>{t.servers.form.serverIp}</label>
            <input
              type="text"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="123.45.67.89"
              spellCheck={false}
              autoComplete="off"
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>{t.servers.form.port}</label>
            <input
              type="text"
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
              placeholder={t.servers.form.portPlaceholder}
              className={INPUT}
            />
          </div>
        </div>

        <div>
          <label className={LABEL}>{t.servers.form.username}</label>
          <input
            type="text"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            placeholder={t.servers.form.usernamePlaceholder}
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
          />
        </div>

        <div>
          <label className={LABEL}>{t.servers.form.authentication}</label>
          <div className="flex gap-1 bg-muted/50 rounded-[10px] p-[3px] mb-3">
            <button
              type="button"
              onClick={() => setSshAuthMethod("password")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                sshAuthMethod === "password"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Lock className="size-3.5" />
              {t.servers.form.password}
            </button>
            <button
              type="button"
              onClick={() => setSshAuthMethod("key")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                sshAuthMethod === "key"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <KeyRound className="size-3.5" />
              {t.servers.form.sshKey}
            </button>
            <button
              type="button"
              onClick={() => setSshAuthMethod("agent")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                sshAuthMethod === "agent"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Network className="size-3.5" />
              {t.servers.form.agent}
            </button>
          </div>

          {sshAuthMethod === "password" ? (
            <div>
              <label className={LABEL}>{t.servers.form.password}</label>
              <div className="relative">
                <input
                  type={showSshPassword ? "text" : "password"}
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  placeholder={
                    isEditing && server?.sshAuthMethod === "password"
                      ? t.servers.form.passwordPlaceholderKeep
                      : t.servers.form.passwordPlaceholderEnter
                  }
                  autoComplete="off"
                  className={`${INPUT} pe-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowSshPassword((v) => !v)}
                  tabIndex={-1}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showSshPassword ? t.auth.hidePassword : t.auth.showPassword}
                >
                  {showSshPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          ) : sshAuthMethod === "agent" ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-muted/30 px-3.5 py-3">
              <Network className="size-4 shrink-0 mt-0.5 text-primary" />
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {t.servers.form.agentInfoBefore}<span className="text-foreground/80">ssh-agent</span>{t.servers.form.agentInfoAfter}
              </p>
            </div>
          ) : (
            <div className="space-y-[18px]">
              {/* Sub-mode: paste/upload the key in the browser vs. a path to a
                  file on the API host. Only rendered where a path can resolve —
                  see `pathModeOffered`. With one option there is no choice to
                  present, so paste/upload stands alone rather than as a lone
                  segment in a segmented control. */}
              {pathModeOffered && (
                <div className="flex gap-1 bg-muted/50 rounded-[10px] p-[3px]">
                  <button
                    type="button"
                    onClick={() => setSshKeyMode("paste")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                      keyMode === "paste"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground/70"
                    }`}
                  >
                    <ClipboardPaste className="size-3.5" />
                    {t.servers.form.keyModePaste}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSshKeyMode("path")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                      keyMode === "path"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground/70"
                    }`}
                  >
                    <FolderOpen className="size-3.5" />
                    {t.servers.form.keyModePath}
                  </button>
                </div>
              )}

              {keyMode === "paste" ? (
                <div>
                  <label className={LABEL}>{t.servers.form.keyPaste}</label>
                  <textarea
                    value={sshPrivateKey}
                    onChange={(e) => setSshPrivateKey(e.target.value)}
                    placeholder={
                      hasStoredKey
                        ? t.servers.form.keyStoredKeep
                        : t.servers.form.keyPastePlaceholder
                    }
                    spellCheck={false}
                    autoComplete="off"
                    rows={6}
                    className={`${INPUT} font-mono text-xs resize-y`}
                  />
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <p className="text-xs text-muted-foreground/60">
                      {t.servers.form.keyPasteHelp}
                    </p>
                    <button
                      type="button"
                      onClick={() => keyFileInputRef.current?.click()}
                      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 bg-muted/30 text-xs font-medium text-foreground hover:bg-muted/60 transition-colors"
                    >
                      <Upload className="size-3.5 text-muted-foreground" />
                      {t.servers.form.keyUploadFile}
                    </button>
                  </div>
                  <input
                    ref={keyFileInputRef}
                    type="file"
                    onChange={handleKeyFileUpload}
                    className="hidden"
                  />
                </div>
              ) : (
                <div>
                  <label className={LABEL}>{t.servers.form.keyPath}</label>
                  {/* Absolute placeholder on purpose: the API's
                      resolveSafeSshKeyPath rejects "~/…", so the tilde shape this
                      field used to suggest could only ever fail. */}
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={sshKeyPath}
                      onChange={(e) => setSshKeyPath(e.target.value)}
                      placeholder="/root/.ssh/id_ed25519"
                      spellCheck={false}
                      autoComplete="off"
                      className={INPUT}
                    />
                    {canBrowseKey && (
                      <button
                        type="button"
                        onClick={handleBrowseKey}
                        className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-border/50 bg-muted/30 text-sm font-medium text-foreground hover:bg-muted/60 transition-colors"
                      >
                        <FolderOpen className="size-4 text-muted-foreground" />
                        {t.servers.form.keyPathBrowse}
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground/60 mt-1.5">
                    {t.servers.form.keyPathHelp}
                  </p>
                </div>
              )}
              <div>
                <label className={LABEL}>
                  {t.servers.form.passphrase}{" "}
                  <span className="text-muted-foreground/50 font-normal">
                    {t.servers.form.optional}
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showPassphrase ? "text" : "password"}
                    value={sshKeyPassphrase}
                    onChange={(e) => setSshKeyPassphrase(e.target.value)}
                    placeholder={t.servers.form.passphrasePlaceholder}
                    autoComplete="off"
                    className={`${INPUT} pe-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassphrase((v) => !v)}
                    tabIndex={-1}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={showPassphrase ? t.auth.hidePassword : t.auth.showPassword}
                  >
                    {showPassphrase ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
          />
          {t.servers.form.advanced}
        </button>

        {showAdvanced && (
          <div className="space-y-[18px]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>
                  {t.servers.form.jumpHost}{" "}
                  <span className="text-muted-foreground/50 font-normal">
                    {t.servers.form.optional}
                  </span>
                </label>
                <input
                  type="text"
                  value={jumpHost}
                  onChange={(e) => setJumpHost(e.target.value)}
                  placeholder="user@bastion.example.com"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL}>
                  {t.servers.form.extraArgs}{" "}
                  <span className="text-muted-foreground/50 font-normal">
                    {t.servers.form.optional}
                  </span>
                </label>
                <input
                  type="text"
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  placeholder="-o StrictHostKeyChecking=no"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
            </div>
          </div>
        )}

        {!isModal && <div className="pt-1 space-y-2.5">{actions}</div>}
      </div>

      {isModal && (
        <div className="px-5 py-4 border-t border-border/50 bg-muted/10 space-y-2.5">{actions}</div>
      )}
    </div>
  );
}
