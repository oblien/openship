import type { OnboardingState } from "@repo/onboarding";

export interface StepProps {
  state: OnboardingState;
  onUpdate: (patch: Partial<OnboardingState>) => void;
  onNext: () => void;
  onBack?: () => void;
}
