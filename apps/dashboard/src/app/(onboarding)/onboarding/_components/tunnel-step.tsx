"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import type { TunnelConfig } from "@repo/onboarding";
import type { StepProps } from "./step-props";

type Provider = "edge" | "cloudflare" | "ngrok";

export function TunnelStep({ state, onUpdate, onNext, onBack }: StepProps) {
  const { t } = useI18n();

  const PROVIDERS: {
    id: Provider;
    title: string;
    desc: string;
    icon: IconName;
    badge?: string;
  }[] = [
    {
      id: "edge",
      title: t.onboarding.tunnel.providers.edge.title,
      desc: t.onboarding.tunnel.providers.edge.desc,
      icon: "bolt",
      badge: t.onboarding.tunnel.providers.edge.badge,
    },
    {
      id: "cloudflare",
      title: t.onboarding.tunnel.providers.cloudflare.title,
      desc: t.onboarding.tunnel.providers.cloudflare.desc,
      icon: "shield",
    },
    {
      id: "ngrok",
      title: t.onboarding.tunnel.providers.ngrok.title,
      desc: t.onboarding.tunnel.providers.ngrok.desc,
      icon: "terminal",
    },
  ];

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
          <button className="ob-btn-back" aria-label={t.onboarding.common.goBack} onClick={onBack}>
            <UiIcon name="arrow-left" size={18} className="rtl:rotate-180" />
          </button>
        )}

        <div className="ob-card-icon ob-card-icon--center">
          <UiIcon name="globe" size={24} />
        </div>

        <h2>{t.onboarding.tunnel.title}</h2>
        <p className="ob-subtitle">
          {t.onboarding.tunnel.subtitle}
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
                <div className="ob-tunnel-card-icon"><UiIcon name={Icon} size={20} /></div>
                <div className="ob-tunnel-card-content">
                  <div className="ob-tunnel-card-header">
                    <span className="ob-tunnel-card-title">{p.title}</span>
                    {p.badge && <span className="ob-tunnel-card-badge">{p.badge}</span>}
                  </div>
                  <span className="ob-tunnel-card-desc">{p.desc}</span>
                </div>
                <div className="ob-tunnel-card-check">
                  <UiIcon name="check" size={16} />
                </div>
              </button>
            );
          })}
        </div>

        {/* Token input (shown for cloudflare / ngrok) */}
        {needsToken && (
          <div className="ob-form-group">
            <label htmlFor="ob-tunnel-token">
              {selected === "cloudflare" ? t.onboarding.tunnel.cloudflareTokenLabel : t.onboarding.tunnel.ngrokTokenLabel}
            </label>
            <input
              id="ob-tunnel-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              placeholder={selected === "cloudflare" ? t.onboarding.tunnel.cloudflarePlaceholder : t.onboarding.tunnel.ngrokPlaceholder}
              autoComplete="off"
            />
          </div>
        )}

        {/* Edge login hint */}
        {selected === "edge" && (
          <div className="ob-pref-hint">
            <UiIcon name="info" size={14} />
            {t.onboarding.tunnel.edgeHint}
          </div>
        )}

        <button className="ob-btn-primary" onClick={handleContinue}>
          {selected === "edge" ? t.onboarding.tunnel.signInContinue : t.onboarding.common.continue}
        </button>
      </div>
    </div>
  );
}
