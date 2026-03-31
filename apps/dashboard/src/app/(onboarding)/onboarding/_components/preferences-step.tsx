"use client";

import { useState } from "react";
import type { BuildMode } from "@repo/onboarding";
import type { StepProps } from "./step-props";

/* ── Inline SVGs matching old design ── */
const GearIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>
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

/* ── Pref option icons ── */
const BoxIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    <polyline points="7.5 4.21 12 6.81 16.5 4.21"/>
    <polyline points="7.5 19.79 7.5 14.6 3 12"/>
    <polyline points="21 12 16.5 14.6 16.5 19.79"/>
    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
    <line x1="12" y1="22.08" x2="12" y2="12"/>
  </svg>
);
const CloudIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
  </svg>
);
const MonitorIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2"/>
    <line x1="8" y1="21" x2="16" y2="21"/>
    <line x1="12" y1="17" x2="12" y2="21"/>
  </svg>
);

type PrefOption = {
  id: BuildMode;
  title: string;
  desc: string;
  icon: () => React.JSX.Element;
};

const OPTIONS: PrefOption[] = [
  { id: "auto", title: "Auto", desc: "We pick the best option per framework", icon: BoxIcon },
  { id: "server", title: "Remote", desc: "Build on the deployment server directly", icon: CloudIcon },
  { id: "local", title: "Local", desc: "Build on this Mac, then push to the server", icon: MonitorIcon },
];

export function PreferencesStep({ state, onUpdate, onNext, onBack }: StepProps) {
  const [selected, setSelected] = useState<BuildMode>(state.buildMode);

  function handleContinue() {
    onUpdate({ buildMode: selected });
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
          <GearIcon />
        </div>

        <h2>Build Preferences</h2>
        <p className="ob-subtitle">
          Choose how your projects are built when deploying.<br/>
          You can change this later in settings.
        </p>

        <div className="ob-pref-cards">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const isActive = selected === opt.id;
            return (
              <button
                key={opt.id}
                className={`ob-pref-card${isActive ? " active" : ""}`}
                onClick={() => setSelected(opt.id)}
              >
                <div className="ob-pref-card-icon"><Icon /></div>
                <div className="ob-pref-card-content">
                  <span className="ob-pref-card-title">{opt.title}</span>
                  <span className="ob-pref-card-desc">{opt.desc}</span>
                </div>
                <div className="ob-pref-card-check">
                  <CheckIcon />
                </div>
              </button>
            );
          })}
        </div>

        <p className="ob-pref-hint">
          Git push deployments always build on the server — this only applies to manual deploys.
        </p>

        <button className="ob-btn-primary" onClick={handleContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
