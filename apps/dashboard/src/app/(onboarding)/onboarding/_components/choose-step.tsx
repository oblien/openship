"use client";

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
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
);
const SwapIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
);

export function ChooseStep({ onUpdate, onNext }: StepProps) {
  return (
    <div className="ob-screen ob-screen--choose">
      <div className="ob-screen-inner ob-screen-inner--wide">
        <div className="ob-choose-header ob-anim-fade ob-anim-d1">
          <h1>Welcome to Openship</h1>
          <p className="ob-subtitle">
            Choose how you&apos;d like to run Openship. Both options give you every
            feature — and you can switch anytime.
          </p>
        </div>

        <div className="ob-cards-row ob-anim-fade ob-anim-d2">
          {/* Cloud card */}
          <div className="ob-choice-card">
            <div className="ob-card-icon"><CloudIcon /></div>
            <h3>Openship Cloud</h3>
            <p className="ob-card-desc">
              We handle infrastructure, updates, and backups. Just sign in and start deploying.
            </p>
            <ul className="ob-card-perks">
              <li>No server needed</li>
              <li>Free tier included</li>
              <li>Managed &amp; always up to date</li>
            </ul>
            <button
              className="ob-btn-card ob-btn-card--accent"
              onClick={() => { onUpdate({ path: "cloud" }); onNext(); }}
            >
              Continue with Cloud
              <ArrowIcon />
            </button>
          </div>

          {/* Vertical divider */}
          <div className="ob-cards-divider">
            <div className="ob-divider-line" />
            <span className="ob-divider-label">or</span>
            <div className="ob-divider-line" />
          </div>

          {/* Self-host card */}
          <div className="ob-choice-card">
            <div className="ob-card-icon"><ServerIcon /></div>
            <h3>Self-Hosted</h3>
            <p className="ob-card-desc">
              Run Openship on your own hardware. Connect a remote server or use this machine.
            </p>
            <ul className="ob-card-perks">
              <li>Full data ownership</li>
              <li>Remote server or this Mac</li>
              <li>We handle the rest</li>
            </ul>
            <button
              className="ob-btn-card ob-btn-card--outline"
              onClick={() => { onUpdate({ path: "selfhost" }); onNext(); }}
            >
              Set Up My Server
              <ArrowIcon />
            </button>
          </div>
        </div>

        <p className="ob-migrate-note ob-anim-fade ob-anim-d3">
          <SwapIcon />
          Switch between Cloud and Self-Hosted anytime with one click — no lock-in, ever.
        </p>
      </div>
    </div>
  );
}
