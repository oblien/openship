"use client";

import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/onboarding";
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
const RemoteServerIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/>
    <path d="M21 14H3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1z"/>
    <circle cx="7" cy="7" r="1" fill="currentColor"/>
    <circle cx="7" cy="17" r="1" fill="currentColor"/>
  </svg>
);
const MonitorIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2"/>
    <line x1="8" y1="21" x2="16" y2="21"/>
    <line x1="12" y1="17" x2="12" y2="21"/>
  </svg>
);
const ChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
);
const BackIcon = () => (
  <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
  </svg>
);

export function SelfhostChoiceStep({ onUpdate, onNext, onBack }: StepProps) {
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

        <h2>Where should Openship run?</h2>
        <p className="ob-subtitle">
          Pick where to install the Openship platform.<br/>
          Both options give you full control and data ownership.
        </p>

        <div className="ob-selfhost-choices">
          {/* This Machine */}
          <button
            className="ob-selfhost-choice-card"
            onClick={() => {
              onUpdate({
                hostingMode: "local",
                apiUrl: LOCAL_API_URL,
                dashboardUrl: LOCAL_DASHBOARD_URL,
                buildMode: "local",
                ssh: undefined,
              });
              onNext();
            }}
          >
            <div className="ob-selfhost-choice-icon"><MonitorIcon /></div>
            <div className="ob-selfhost-choice-content">
              <span className="ob-selfhost-choice-title">
                This Machine <span className="ob-badge-beta">Beta</span>
              </span>
              <span className="ob-selfhost-choice-desc">
                Install Openship right here — no SSH, no remote setup needed
              </span>
            </div>
            <ChevronRight />
          </button>

          {/* Another Server */}
          <button
            className="ob-selfhost-choice-card"
            onClick={() => { onUpdate({ hostingMode: "remote" }); onNext(); }}
          >
            <div className="ob-selfhost-choice-icon"><RemoteServerIcon /></div>
            <div className="ob-selfhost-choice-content">
              <span className="ob-selfhost-choice-title">Another Server</span>
              <span className="ob-selfhost-choice-desc">
                Connect to a remote server, VPS, or any machine on your network via SSH
              </span>
            </div>
            <ChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
}
