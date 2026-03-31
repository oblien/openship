"use client";

import { useState, useCallback, useRef, Suspense } from "react";
import type { OnboardingStep, OnboardingState } from "@repo/onboarding";
import { nextStep, prevStep } from "@repo/onboarding";
import { ChooseStep } from "./_components/choose-step";
import { SelfhostChoiceStep } from "./_components/selfhost-choice-step";
import { SshStep } from "./_components/ssh-step";
import { TunnelStep } from "./_components/tunnel-step";
import { PreferencesStep } from "./_components/preferences-step";
import { LoadingStep } from "./_components/loading-step";
import "./onboarding.css";

/* ── SVG icons used in the top bar ── */
const GlobeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
);
const GitHubIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.1.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61a3.18 3.18 0 0 0-1.33-1.76c-1.09-.74.08-.73.08-.73a2.52 2.52 0 0 1 1.84 1.24 2.56 2.56 0 0 0 3.5 1 2.56 2.56 0 0 1 .76-1.6c-2.67-.3-5.47-1.33-5.47-5.93a4.64 4.64 0 0 1 1.24-3.22 4.3 4.3 0 0 1 .12-3.18s1-.32 3.3 1.23a11.38 11.38 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23a4.3 4.3 0 0 1 .12 3.18 4.64 4.64 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92a2.87 2.87 0 0 1 .82 2.23v3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .3"/></svg>
);

function OnboardingInner() {
  const [step, setStep] = useState<OnboardingStep>("choose");
  const [state, setState] = useState<OnboardingState>({
    buildMode: "auto",
    apiUrl: "",
    dashboardUrl: "",
  });

  // Ref keeps latest state so goNext/goBack never read stale closures
  const stateRef = useRef(state);

  const updateState = useCallback(
    (patch: Partial<OnboardingState>) => {
      stateRef.current = { ...stateRef.current, ...patch };
      setState(stateRef.current);
    },
    [],
  );

  const goNext = useCallback(() => {
    const next = nextStep(step, stateRef.current);
    if (next) setStep(next);
  }, [step]);

  const goBack = useCallback(() => {
    const prev = prevStep(step, stateRef.current);
    if (prev) setStep(prev);
  }, [step]);

  return (
    <>
      {/* Aurora background */}
      <div className="ob-aurora">
        <div className="ob-aurora-blob ob-aurora-core" />
        <div className="ob-aurora-blob ob-aurora-left" />
        <div className="ob-aurora-blob ob-aurora-right" />
      </div>

      {/* Top bar */}
      <div className="ob-top-bar">
        <div className="ob-logo">
          <div className="ob-logo-circle" aria-hidden="true" />
          <span className="ob-logo-text">Openship</span>
        </div>
        <div className="ob-top-bar-links">
          <a className="ob-top-bar-link" href="https://openship.dev" target="_blank" rel="noopener noreferrer" title="Website">
            <GlobeIcon />
          </a>
          <a className="ob-top-bar-link" href="https://github.com/oblien/openship" target="_blank" rel="noopener noreferrer" title="GitHub">
            <GitHubIcon />
          </a>
        </div>
      </div>

      {/* Main container */}
      <div className="ob-root">
        {step === "choose" && (
          <ChooseStep state={state} onUpdate={updateState} onNext={goNext} />
        )}
        {step === "selfhost-choice" && (
          <SelfhostChoiceStep state={state} onUpdate={updateState} onNext={goNext} onBack={goBack} />
        )}
        {step === "ssh" && (
          <SshStep state={state} onUpdate={updateState} onNext={goNext} onBack={goBack} />
        )}
        {step === "tunnel" && (
          <TunnelStep state={state} onUpdate={updateState} onNext={goNext} onBack={goBack} />
        )}
        {step === "preferences" && (
          <PreferencesStep state={state} onUpdate={updateState} onNext={goNext} onBack={goBack} />
        )}
        {step === "loading" && (
          <LoadingStep state={state} onBack={goBack} />
        )}
      </div>
    </>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingInner />
    </Suspense>
  );
}
