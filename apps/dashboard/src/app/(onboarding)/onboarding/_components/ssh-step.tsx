"use client";

import { useState } from "react";
import {
  validateSshPayload,
  LOCAL_API_URL,
  LOCAL_DASHBOARD_URL,
} from "@repo/onboarding";
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
  <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
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
  const [serverName, setServerName] = useState(state.ssh?.serverName ?? "");
  const [host, setHost] = useState(state.ssh?.host ?? "");
  const [user, setUser] = useState(state.ssh?.user ?? "root");
  const [method, setMethod] = useState<"password" | "key">(
    (state.ssh?.method as "password" | "key") ?? "password",
  );
  const [password, setPassword] = useState(state.ssh?.password ?? "");
  const [keyPath, setKeyPath] = useState(state.ssh?.keyPath ?? "");
  const [passphrase, setPassphrase] = useState(state.ssh?.passphrase ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [port, setPort] = useState(String(state.ssh?.port ?? ""));
  const [jumpHost, setJumpHost] = useState(state.ssh?.jumpHost ?? "");
  const [sshArgs, setSshArgs] = useState(state.ssh?.sshArgs ?? "");
  const [error, setError] = useState<string | null>(null);

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
      apiUrl: LOCAL_API_URL,
      dashboardUrl: LOCAL_DASHBOARD_URL,
    });
    setError(null);
    onNext();
  }

  return (
    <div className="ob-screen">
      <div className="ob-screen-inner">
        {onBack && (
          <button className="ob-btn-back" aria-label="Go back" onClick={onBack}>
            <BackIcon />
          </button>
        )}

        <div className="ob-card-icon ob-card-icon--center">
          <ServerIcon />
        </div>

        <h2>Connect to your server</h2>
        <p className="ob-subtitle">
          Enter your server details and choose an auth method.<br/>
          We&apos;ll install and configure everything automatically.
        </p>

        <div className="ob-form-group">
          <label htmlFor="ob-server-name">Server Name</label>
          <input
            id="ob-server-name"
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder="Production, Staging, Dev..."
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="ob-form-group">
          <label htmlFor="ob-server-ip">Server IP Address</label>
          <input
            id="ob-server-ip"
            type="text"
            value={host}
            onChange={(e) => { setHost(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="123.45.67.89"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="ob-form-group">
          <label htmlFor="ob-server-user">Username</label>
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
            onClick={() => { setMethod("password"); setError(null); }}
          >
            Password
          </button>
          <button
            type="button"
            className={`ob-auth-tab${method === "key" ? " active" : ""}`}
            onClick={() => { setMethod("key"); setError(null); }}
          >
            SSH Key
          </button>
        </div>

        {/* Password panel */}
        {method === "password" && (
          <div className="ob-form-group">
            <label htmlFor="ob-server-password">Password</label>
            <input
              id="ob-server-password"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Server password"
              autoComplete="off"
            />
          </div>
        )}

        {/* Key panel */}
        {method === "key" && (
          <>
            <div className="ob-form-group">
              <label htmlFor="ob-key-path">Key Path</label>
              <div className="ob-input-with-btn">
                <input
                  id="ob-key-path"
                  type="text"
                  value={keyPath}
                  onChange={(e) => { setKeyPath(e.target.value); setError(null); }}
                  placeholder="~/.ssh/id_rsa"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="ob-btn-browse">Browse</button>
              </div>
            </div>
            <div className="ob-form-group">
              <label htmlFor="ob-key-passphrase">
                Passphrase <span className="ob-label-hint">(optional)</span>
              </label>
              <input
                id="ob-key-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Leave blank if none"
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
          Advanced
        </button>

        <div className={`ob-advanced-panel${showAdvanced ? " open" : ""}`}>
          <div className="ob-advanced-grid">
            <div className="ob-form-group">
              <label htmlFor="ob-ssh-port">SSH Port</label>
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
                Jump Host <span className="ob-label-hint">(optional)</span>
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
              Extra SSH Arguments <span className="ob-label-hint">(optional)</span>
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

        <button className="ob-btn-primary" onClick={handleSubmit}>
          Save &amp; Continue
        </button>

        <a
          className="ob-tutorial-link"
          href="https://docs.openship.dev/self-hosting"
          target="_blank"
          rel="noopener noreferrer"
        >
          <InfoIcon />
          Step-by-step setup tutorial
        </a>
      </div>
    </div>
  );
}
