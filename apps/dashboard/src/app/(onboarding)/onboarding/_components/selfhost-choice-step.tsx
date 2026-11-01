"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";
import type { StepProps } from "./step-props";

/* ── Inline SVGs matching old design ── */

export function SelfhostChoiceStep({ onUpdate, onNext, onBack }: StepProps) {
  const { t } = useI18n();
  return (
    <div className="ob-screen">
      <div className="ob-screen-inner">
        {onBack && (
          <button className="ob-btn-back" aria-label={t.onboarding.common.goBack} onClick={onBack}>
            <UiIcon name="arrow-left" size={18} className="rtl:rotate-180" />
          </button>
        )}

        <div className="ob-card-icon ob-card-icon--center">
          <UiIcon name="server" size={24} />
        </div>

        <h2>{t.onboarding.selfhost.title}</h2>
        <p className="ob-subtitle">
          {t.onboarding.selfhost.subtitleLine1}<br/>
          {t.onboarding.selfhost.subtitleLine2}
        </p>

        <div className="ob-selfhost-choices">
          {/* This Machine — not ready yet, disabled */}
          <button
            type="button"
            className="ob-selfhost-choice-card is-disabled"
            disabled
            aria-disabled="true"
          >
            <div className="ob-selfhost-choice-icon"><UiIcon name="monitor" size={22} /></div>
            <div className="ob-selfhost-choice-content">
              <span className="ob-selfhost-choice-title">
                {t.onboarding.selfhost.local.title} <span className="ob-badge-soon">{t.onboarding.selfhost.local.comingSoon}</span>
              </span>
              <span className="ob-selfhost-choice-desc">
                {t.onboarding.selfhost.local.comingSoonDesc}
              </span>
            </div>
          </button>

          {/* Another Server */}
          <button
            className="ob-selfhost-choice-card"
            onClick={() => { onUpdate({ hostingMode: "remote" }); onNext(); }}
          >
            <div className="ob-selfhost-choice-icon"><UiIcon name="server" size={22} /></div>
            <div className="ob-selfhost-choice-content">
              <span className="ob-selfhost-choice-title">{t.onboarding.selfhost.remote.title}</span>
              <span className="ob-selfhost-choice-desc">
                {t.onboarding.selfhost.remote.desc}
              </span>
            </div>
            <UiIcon name="chevron-right" size={16} className="rtl:rotate-180" />
          </button>
        </div>
      </div>
    </div>
  );
}
