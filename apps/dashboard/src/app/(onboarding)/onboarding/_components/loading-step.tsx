"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useState, useCallback, useRef } from "react";
import type { OnboardingState } from "@repo/onboarding";
import { useI18n } from "@/components/i18n-provider";
import { useOnboardingContext } from "../../providers";
import { runLoadingFlow, type LoadingStatus } from "../_lib/loading-flow";

interface LoadingStepProps {
  state: OnboardingState;
  onBack: () => void;
}

export function LoadingStep({ state, onBack }: LoadingStepProps) {
  const { t } = useI18n();
  const { cloudAuthUrl } = useOnboardingContext();
  const [title, setTitle] = useState(t.onboarding.loading.connecting);
  const [message, setMessage] = useState(t.onboarding.loading.verifying);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const startedAttemptRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const setStatus = useCallback((status: LoadingStatus) => {
    setTitle(status.title);
    setMessage(status.message);
  }, []);

  const run = useCallback(async () => {
    cancelledRef.current = false;
    setFailed(false);

    const result = await runLoadingFlow({
      state,
      cloudAuthUrl,
      setStatus,
      isCancelled: () => cancelledRef.current,
      labels: t.onboarding.loading,
    });

    if (!cancelledRef.current && !result.ok) {
      setStatus(result.status);
      setFailed(true);
    }
  }, [cloudAuthUrl, setStatus, state, t]);

  useEffect(() => {
    // Reset cancellation flag on every mount - critical for React strict mode
    // where cleanup sets cancelled=true between unmount/remount, but
    // startedAttemptRef prevents re-running the async flow.
    cancelledRef.current = false;

    if (startedAttemptRef.current === attempt) return;
    startedAttemptRef.current = attempt;
    void run();

    return () => {
      cancelledRef.current = true;
    };
  }, [attempt, run]);

  return (
    <div className="ob-screen">
      <div className="ob-screen-inner">
        {!failed && <UiIcon name="spinner" className="ob-spinner" />}

        <h2>{title}</h2>
        <p className="ob-subtitle">{message}</p>

        {failed && (
          <div className="ob-loading-actions">
            <button
              className="ob-loading-btn ob-loading-btn--accent"
              onClick={() => {
                startedAttemptRef.current = null;
                setAttempt((n) => n + 1);
              }}
            >
              {t.onboarding.loading.retry}
            </button>
            <button
              className="ob-loading-btn ob-loading-btn--text"
              onClick={onBack}
            >
              <span aria-hidden="true" className="rtl:hidden">&larr; </span>
              <span aria-hidden="true" className="hidden rtl:inline">&rarr; </span>
              {t.onboarding.common.back}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
