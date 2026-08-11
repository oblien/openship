"use client";

import { useEffect, useState } from "react";
import { getApiOrigin } from "@/lib/api/urls";
import { useI18n } from "@/components/i18n-provider";
import { api, endpoints, getApiErrorMessage } from "@/lib/api";
import { validateSshPayload } from "@repo/onboarding";
import type { SshPayload } from "@repo/onboarding";
import type { StepProps } from "./step-props";

/* ── Inline SVGs matching old design ── */
const ServerIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" fill="currentColor" />
    <circle cx="6" cy="18" r="1" fill="currentColor" />
  </svg>
);
const BackIcon = () => (
  <svg className="rtl:rotate-180" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
  </svg>
);
const ChevronDownIcon = () => (
  <svg className="ob-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
);
const InfoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
);

export function SshStep({ state, onUpdate, onNext, onBack }: StepProps) {
  const { t } = useI18n();
  const [serverName, setServerName] = useState(state.ssh?.serverName ?? "");
  const [host, setHost] = useState(state.ssh?.host ?? "");
  const [user, setUser] = useState(state.ssh?.user ?? "root");
  const [method, setMethod] = useState<"password" | "key" | "agent">(
    (state.ssh?.method as "password" | "key" | "agent") ?? "password",
  );
  const [password, setPassword] = useState(state.ssh?.password ?? "");
  const [keyPath, setKeyPath] = useState(state.ssh?.keyPath ?? "");
  const [passphrase, setPassphrase] = useState(state.ssh?.passphrase ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [port, setPort] = useState(String(state.ssh?.port ?? ""));
  const [jumpHost, setJumpHost] = useState(state.ssh?.jumpHost ?? "");
  const [sshArgs, setSshArgs] = useState(state.ssh?.sshArgs ?? "");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState(false);
  // Native SSH-key file picker is Electron-only (no filesystem access on web).
  // Detect the bridge after mount to avoid an SSR/hydration mismatch.
  const [canBrowseKey, setCanBrowseKey] = useState(false);
  useEffect(() => {
    setCanBrowseKey(
      !!(window as { desktop?: { onboarding?: { browseFile?: () => Promise<string | null> } } })
        .desktop?.onboarding?.browseFile,
    );
  }, []);

  async function handleBrowseKey() {
    const bridge = (window as { desktop?: { onboarding?: { browseFile?: () => Promise<string | null> } } })
      .desktop?.onboarding?.browseFile;
    const picked = await bridge?.();
    if (picked) {
      setKeyPath(picked);
      setError(null);
    }
  }

  async function handleTest() {
    const trimmedHost = host.trim();
    if (!trimmedHost) {
      setError(t.onboarding.ssh.testFailed);
      return;
    }
    setTesting(true);
    setTestOk(false);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        sshHost: trimmedHost,
        sshPort: parseInt(port, 10) || 22,
        sshUser: user.trim() || "root",
        sshAuthMethod: method,
      };
      if (method === "password") payload.sshPassword = password;
      if (method === "key") {
        if (keyPath.trim()) payload.sshKeyPath = keyPath.trim();
        if (passphrase) payload.sshKeyPassphrase = passphrase;
      }
      if (jumpHost.trim()) payload.sshJumpHost = jumpHost.trim();
      if (sshArgs.trim()) payload.sshArgs = sshArgs.trim();

      const res = await api.post<{ ok: boolean; message: string }>(
        endpoints.system.onboardingTestConnection,
        payload,
      );
      if (res.ok) setTestOk(true);
      else setError(res.message || t.onboarding.ssh.testFailed);
    } catch (err) {
      // Non-2xx (auth failure 400 / unreachable 502) surface as thrown ApiErrors.
      setError(getApiErrorMessage(err, t.onboarding.ssh.testFailed));
    } finally {
      setTesting(false);
    }
  }

  function handleSubmit() {
    const trimmedHost = host.trim();

    const payload: SshPayload = {
      host: trimmedHost,
      user: user.trim() || "root",
      method,
    };
    if (serverName.trim()) payload.serverName = serverName.trim();
    if (method === "password") payload.password = password;
    if (method === "key") {
      payload.keyPath = keyPath.trim();
      if (passphrase) payload.passphrase = passphrase;
    }
    const p = parseInt(port, 10);
    if (p && p !== 22) payload.port = p;
    if (jumpHost.trim()) payload.jumpHost = jumpHost.trim();
    if (sshArgs.trim()) payload.sshArgs = sshArgs.trim();

    const validationErr = validateSshPayload(payload);
    if (validationErr) {
      setError(validationErr);
      return;
    }

    onUpdate({
      ssh: payload,
      apiUrl: getApiOrigin(),
      dashboardUrl: window.location.origin,
    });
    setError(null);
    onNext();
  }

  return (
    <div className="ob-screen">
      <div className="ob-screen-inner">
        {onBack && (
          <button className="ob-btn-back" aria-label={t.onboarding.common.goBack} onClick={onBack}>
            <BackIcon />
          </button>
        )}

        <div className="ob-card-icon ob-card-icon--center">
          <ServerIcon />
        </div>

        <h2>{t.onboarding.ssh.title}</h2>
        <p className="ob-subtitle">
          {t.onboarding.ssh.subtitleLine1}<br/>
          {t.onboarding.ssh.subtitleLine2}
        </p>

        <div className="ob-form-group">
          <label htmlFor="ob-server-name">{t.onboarding.ssh.serverNameLabel}</label>
          <input
            id="ob-server-name"
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder={t.onboarding.ssh.serverNamePlaceholder}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="ob-form-group">
          <label htmlFor="ob-server-ip">{t.onboarding.ssh.serverIpLabel}</label>
          <input
            id="ob-server-ip"
            type="text"
            value={host}
            onChange={(e) => { setHost(e.target.value); setError(null); setTestOk(false); }}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="123.45.67.89"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="ob-form-group">
          <label htmlFor="ob-server-user">{t.onboarding.ssh.usernameLabel}</label>
          <input
            id="ob-server-user"
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="root"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Auth method toggle */}
        <div className="ob-auth-toggle">
          <button
            type="button"
            className={`ob-auth-tab${method === "password" ? " active" : ""}`}
            onClick={() => { setMethod("password"); setError(null); setTestOk(false); }}
          >
            {t.onboarding.ssh.methodPassword}
          </button>
          <button
            type="button"
            className={`ob-auth-tab${method === "key" ? " active" : ""}`}
            onClick={() => { setMethod("key"); setError(null); setTestOk(false); }}
          >
            {t.onboarding.ssh.methodKey}
          </button>
          <button
            type="button"
            className={`ob-auth-tab${method === "agent" ? " active" : ""}`}
            onClick={() => { setMethod("agent"); setError(null); setTestOk(false); }}
          >
            {t.onboarding.ssh.methodAgent}
          </button>
        </div>

        {/* Agent panel */}
        {method === "agent" && (
          <p className="ob-auth-hint">
            {t.onboarding.ssh.agentHint}
          </p>
        )}

        {/* Password panel */}
        {method === "password" && (
          <div className="ob-form-group">
            <label htmlFor="ob-server-password">{t.onboarding.ssh.passwordLabel}</label>
            <input
              id="ob-server-password"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); setTestOk(false); }}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder={t.onboarding.ssh.passwordPlaceholder}
              autoComplete="off"
            />
          </div>
        )}

        {/* Key panel */}
        {method === "key" && (
          <>
            <div className="ob-form-group">
              <label htmlFor="ob-key-path">{t.onboarding.ssh.keyPathLabel}</label>
              <div className="ob-input-with-btn">
                <input
                  id="ob-key-path"
                  type="text"
                  value={keyPath}
                  onChange={(e) => { setKeyPath(e.target.value); setError(null); setTestOk(false); }}
                  placeholder="~/.ssh/id_rsa"
                  spellCheck={false}
                  autoComplete="off"
                />
                {canBrowseKey && (
                  <button type="button" className="ob-btn-browse" onClick={handleBrowseKey}>
                    {t.onboarding.ssh.browse}
                  </button>
                )}
              </div>
            </div>
            <div className="ob-form-group">
              <label htmlFor="ob-key-passphrase">
                {t.onboarding.ssh.passphraseLabel} <span className="ob-label-hint">{t.onboarding.common.optional}</span>
              </label>
              <input
                id="ob-key-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t.onboarding.ssh.passphrasePlaceholder}
                autoComplete="off"
              />
            </div>
          </>
        )}

        {/* Advanced toggle */}
        <button
          type="button"
          className={`ob-btn-advanced${showAdvanced ? " open" : ""}`}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <ChevronDownIcon />
          {t.onboarding.ssh.advanced}
        </button>

        <div className={`ob-advanced-panel${showAdvanced ? " open" : ""}`}>
          <div className="ob-advanced-grid">
            <div className="ob-form-group">
              <label htmlFor="ob-ssh-port">{t.onboarding.ssh.sshPortLabel}</label>
              <input
                id="ob-ssh-port"
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="ob-form-group">
              <label htmlFor="ob-jump-host">
                {t.onboarding.ssh.jumpHostLabel} <span className="ob-label-hint">{t.onboarding.common.optional}</span>
              </label>
              <input
                id="ob-jump-host"
                type="text"
                value={jumpHost}
                onChange={(e) => setJumpHost(e.target.value)}
                placeholder="user@bastion.example.com"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
          <div className="ob-form-group">
            <label htmlFor="ob-ssh-args">
              {t.onboarding.ssh.extraArgsLabel} <span className="ob-label-hint">{t.onboarding.common.optional}</span>
            </label>
            <input
              id="ob-ssh-args"
              type="text"
              value={sshArgs}
              onChange={(e) => setSshArgs(e.target.value)}
              placeholder="-o StrictHostKeyChecking=no"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>

        {error && (
          <div className="ob-status-message error">{error}</div>
        )}
        {testOk && !error && (
          <div className="ob-status-message success">{t.onboarding.ssh.connected}</div>
        )}

        <button
          type="button"
          className={`ob-btn-secondary${testOk ? " is-ok" : ""}`}
          onClick={handleTest}
          disabled={testing || !host.trim()}
        >
          {testing ? t.onboarding.ssh.testing : testOk ? t.onboarding.ssh.connected : t.onboarding.ssh.testConnection}
        </button>

        <button className="ob-btn-primary" onClick={handleSubmit}>
          {t.onboarding.ssh.submit}
        </button>

        <a
          className="ob-tutorial-link"
          href="https://openship.io/docs/self-hosting"
          target="_blank"
          rel="noopener noreferrer"
        >
          <InfoIcon />
          {t.onboarding.ssh.tutorial}
        </a>
      </div>
    </div>
  );
}
