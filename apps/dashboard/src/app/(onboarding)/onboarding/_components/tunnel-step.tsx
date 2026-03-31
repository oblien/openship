"use client";

import { useState } from "react";
import type { TunnelConfig } from "@repo/onboarding";
import type { StepProps } from "./step-props";

type Provider = "edge" | "cloudflare" | "ngrok";

/* ── Inline SVGs matching old design ── */
const GlobeIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <path d="M2 12h20"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>
);
const BackIcon = () => (
  <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
  </svg>
);
const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
);
const InfoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
);

/* ── Tunnel provider icons ── */
const BoltIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
  </svg>
);
const ShieldIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);
const TerminalIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"/>
    <line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
);

const PROVIDERS: {
  id: Provider;
  title: string;
  desc: string;
  icon: () => React.JSX.Element;
  badge?: string;
}[] = [
  {
    id: "edge",
    title: "Openship Edge",
    desc: "Zero config. Automatic SSL, high availability, and DDoS protection — all built in.",
    icon: BoltIcon,
    badge: "Recommended",
  },
  {
    id: "cloudflare",
    title: "Cloudflare Tunnel",
    desc: "Use your own Cloudflare account. Free tier available.",
    icon: ShieldIcon,
  },
  {
    id: "ngrok",
    title: "ngrok",
    desc: "Expose services with your ngrok auth token.",
    icon: TerminalIcon,
  },
];

export function TunnelStep({ state, onUpdate, onNext, onBack }: StepProps) {
  const [selected, setSelected] = useState<Provider>(
    state.tunnel?.provider ?? "edge",
  );
  const [token, setToken] = useState(state.tunnel?.token ?? "");

  const needsToken = selected === "cloudflare" || selected === "ngrok";

  function handleContinue() {
    if (needsToken && !token.trim()) return;

    const tunnel: TunnelConfig = { provider: selected };
    if (needsToken) tunnel.token = token.trim();

    onUpdate({ tunnel });
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
          <GlobeIcon />
        </div>

        <h2>Internet Access</h2>
        <p className="ob-subtitle">
          Your server needs a way to be reachable from the internet for webhooks, SSL, and public access.
        </p>

        <div className="ob-tunnel-choices">
          {PROVIDERS.map((p) => {
            const Icon = p.icon;
            const isActive = selected === p.id;
            return (
              <button
                key={p.id}
                className={`ob-tunnel-card${isActive ? " active" : ""}`}
                onClick={() => { setSelected(p.id); setToken(""); }}
              >
                <div className="ob-tunnel-card-icon"><Icon /></div>
                <div className="ob-tunnel-card-content">
                  <div className="ob-tunnel-card-header">
                    <span className="ob-tunnel-card-title">{p.title}</span>
                    {p.badge && <span className="ob-tunnel-card-badge">{p.badge}</span>}
                  </div>
                  <span className="ob-tunnel-card-desc">{p.desc}</span>
                </div>
                <div className="ob-tunnel-card-check">
                  <CheckIcon />
                </div>
              </button>
            );
          })}
        </div>

        {/* Token input (shown for cloudflare / ngrok) */}
        {needsToken && (
          <div className="ob-form-group">
            <label htmlFor="ob-tunnel-token">
              {selected === "cloudflare" ? "Cloudflare Tunnel Token" : "ngrok Auth Token"}
            </label>
            <input
              id="ob-tunnel-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              placeholder={`Paste your ${selected === "cloudflare" ? "tunnel" : "ngrok auth"} token`}
              autoComplete="off"
            />
          </div>
        )}

        {/* Edge login hint */}
        {selected === "edge" && (
          <div className="ob-pref-hint">
            <InfoIcon />
            Openship Edge requires an Openship account. You&apos;ll sign in to continue.
          </div>
        )}

        <button className="ob-btn-primary" onClick={handleContinue}>
          {selected === "edge" ? "Sign In & Continue" : "Continue"}
        </button>
      </div>
    </div>
  );
}
