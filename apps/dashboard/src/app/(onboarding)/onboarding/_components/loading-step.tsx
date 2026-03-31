"use client";

import { useEffect, useState, useCallback } from "react";
import {
  buildSshSettings,
  buildSetupPayload,
} from "@repo/onboarding";
import { api, getApiBaseUrl } from "@/lib/api";
import type { OnboardingState } from "@repo/onboarding";

interface LoadingStepProps {
  state: OnboardingState;
  onBack: () => void;
}

export function LoadingStep({ state, onBack }: LoadingStepProps) {
  const [title, setTitle] = useState("Connecting\u2026");
  const [message, setMessage] = useState("Verifying your server");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const run = useCallback(async () => {
    setFailed(false);

    if (state.path === "cloud") {
      setTitle("Redirecting to Openship Cloud\u2026");
      setMessage("You\u2019ll complete sign-in in a new tab");
      window.open("https://app.openship.io", "_blank");
      return;
    }

    setTitle("Saving configuration\u2026");
    setMessage("Almost there");

    const system = state.ssh ? buildSshSettings(state.ssh) : undefined;
    const payload = buildSetupPayload({
      system,
      tunnel: state.tunnel,
      buildMode: state.buildMode,
      authMode: "none",
    });

    try {
      await api.post("system/onboarding", payload);
    } catch {
      setTitle("Could not save configuration");
      setMessage("The API didn\u2019t respond. Make sure services are running.");
      setFailed(true);
      return;
    }

    setTitle("Setting up your account\u2026");
    setMessage("Creating your session");

    const base = getApiBaseUrl().replace(/\/$/, "");
    window.location.href = `${base}/auth/desktop-login`;
  }, [state]);

  useEffect(() => {
    void run();
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ob-screen">
      <div className="ob-screen-inner">
        {!failed && <div className="ob-spinner" />}

        <h2>{title}</h2>
        <p className="ob-subtitle">{message}</p>

        {failed && (
          <div className="ob-loading-actions">
            <button
              className="ob-loading-btn ob-loading-btn--accent"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </button>
            <button
              className="ob-loading-btn ob-loading-btn--text"
              onClick={onBack}
            >
              &larr; Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
