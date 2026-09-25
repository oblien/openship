"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";
import type { StepProps } from "./step-props";

/* ── Inline SVGs matching old design exactly ── */

export function ChooseStep({ onUpdate, onNext }: StepProps) {
  const { t } = useI18n();
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
          {/* Cloud card */}
          <div className="ob-choice-card">
            <div className="ob-card-icon"><UiIcon name="cloud" size={24} /></div>
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
              <UiIcon name="arrow-right" size={14} className="rtl:rotate-180" />
            </button>
          </div>

          {/* Vertical divider */}
          <div className="ob-cards-divider">
            <div className="ob-divider-line" />
            <span className="ob-divider-label">{t.onboarding.choose.or}</span>
            <div className="ob-divider-line" />
          </div>

          {/* Self-host card */}
          <div className="ob-choice-card">
            <div className="ob-card-icon"><UiIcon name="server" size={24} /></div>
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
              <UiIcon name="arrow-right" size={14} className="rtl:rotate-180" />
            </button>
          </div>
        </div>

        <p className="ob-migrate-note ob-anim-fade ob-anim-d3">
          <UiIcon name="arrows-up-down" size={15} />
          {t.onboarding.choose.migrateNote}
        </p>
      </div>
    </div>
  );
}
