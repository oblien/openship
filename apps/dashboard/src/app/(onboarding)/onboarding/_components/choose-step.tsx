"use client";

import { useI18n } from "@/components/i18n-provider";
import { useOnboardingContext } from "../../providers";
import type { StepProps } from "./step-props";

/* ── Inline SVGs matching old design exactly ── */
const CloudIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </svg>
);
const ServerIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" fill="currentColor" />
    <circle cx="6" cy="18" r="1" fill="currentColor" />
  </svg>
);
const ArrowIcon = () => (
  <svg className="rtl:rotate-180" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
);
const SwapIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
);

export function ChooseStep({ onUpdate, onNext }: StepProps) {
  const { t } = useI18n();
  const { deployMode, features } = useOnboardingContext();
  const localOnly = deployMode === "desktop" || !features.cloudConnect;
  return (
    <div className="ob-screen ob-screen--choose">
      <div className="ob-screen-inner ob-screen-inner--wide">
        <div className="ob-choose-header ob-anim-fade ob-anim-d1">
          <h1>{t.onboarding.choose.title}</h1>
          <p className="ob-subtitle">
            {t.onboarding.choose.subtitle}
          </p>
        </div>

        <div className="ob-cards-row ob-anim-fade ob-anim-d2">
          {/* Cloud is a hosted-product choice, never a Desktop identity mode. */}
          {!localOnly && <div className="ob-choice-card">
            <div className="ob-card-icon"><CloudIcon /></div>
            <h3>{t.onboarding.choose.cloud.name}</h3>
            <p className="ob-card-desc">
              {t.onboarding.choose.cloud.desc}
            </p>
            <ul className="ob-card-perks">
              <li>{t.onboarding.choose.cloud.perk1}</li>
              <li>{t.onboarding.choose.cloud.perk2}</li>
              <li>{t.onboarding.choose.cloud.perk3}</li>
            </ul>
            <button
              className="ob-btn-card ob-btn-card--accent"
              onClick={() => { onUpdate({ path: "cloud" }); onNext(); }}
            >
              {t.onboarding.choose.cloud.cta}
              <ArrowIcon />
            </button>
          </div>}

          {/* Vertical divider */}
          {!localOnly && <div className="ob-cards-divider">
            <div className="ob-divider-line" />
            <span className="ob-divider-label">{t.onboarding.choose.or}</span>
            <div className="ob-divider-line" />
          </div>}

          {/* Self-host card */}
          <div className="ob-choice-card">
            <div className="ob-card-icon"><ServerIcon /></div>
            <h3>{t.onboarding.choose.selfhost.name}</h3>
            <p className="ob-card-desc">
              {t.onboarding.choose.selfhost.desc}
            </p>
            <ul className="ob-card-perks">
              <li>{t.onboarding.choose.selfhost.perk1}</li>
              <li>{t.onboarding.choose.selfhost.perk2}</li>
              <li>{t.onboarding.choose.selfhost.perk3}</li>
            </ul>
            <button
              className="ob-btn-card ob-btn-card--outline"
              onClick={() => { onUpdate({ path: "selfhost" }); onNext(); }}
            >
              {t.onboarding.choose.selfhost.cta}
              <ArrowIcon />
            </button>
          </div>
        </div>

        <p className="ob-migrate-note ob-anim-fade ob-anim-d3">
          <SwapIcon />
          {t.onboarding.choose.migrateNote}
        </p>
      </div>
    </div>
  );
}
