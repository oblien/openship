import type { OnboardingStep, OnboardingState } from "./types";
import { isPrivateIp } from "./validation";

// ─── Step metadata ───────────────────────────────────────────────────────────

export interface StepDef {
  id: OnboardingStep;
  title: string;
  subtitle: string;
}

export const STEPS: Record<OnboardingStep, StepDef> = {
  choose: {
    id: "choose",
    title: "Get Started",
    subtitle: "Choose how you'd like to use Openship.",
  },
  "selfhost-choice": {
    id: "selfhost-choice",
    title: "Where should Openship run?",
    subtitle: "Pick where to install the Openship platform. Both options give you full control and data ownership.",
  },
  ssh: {
    id: "ssh",
    title: "Connect to your server",
    subtitle: "Enter your server details and choose an auth method. We'll install and configure everything automatically.",
  },
  tunnel: {
    id: "tunnel",
    title: "Internet Access",
    subtitle: "Your server needs a way to be reachable from the internet for webhooks, SSL, and public access.",
  },
  preferences: {
    id: "preferences",
    title: "Build Preferences",
    subtitle: "Choose how your projects are built when deploying. You can change this later in settings.",
  },
  loading: {
    id: "loading",
    title: "Connecting…",
    subtitle: "Verifying your server",
  },
};

/**
 * All possible steps in normal flow order.
 * Not every run visits every step — use `nextStep` / `prevStep` for navigation.
 */
export const STEP_ORDER: OnboardingStep[] = [
  "choose",
  "selfhost-choice",
  "ssh",
  "tunnel",
  "preferences",
  "loading",
];

// ─── Navigation helpers ─────────────────────────────────────────────────────

/**
 * Given the current step and collected state, determine the next step.
 * Returns null if we should complete onboarding (from loading).
 */
export function nextStep(
  current: OnboardingStep,
  state: OnboardingState,
): OnboardingStep | null {
  switch (current) {
    case "choose":
      if (state.path === "cloud") return "loading"; // cloud auth flow
      return "selfhost-choice";

    case "selfhost-choice":
      if (state.hostingMode === "local") return "tunnel"; // local always needs tunnel
      return "ssh"; // remote → SSH form

    case "ssh":
      // After SSH: private IP → tunnel, public IP → preferences
      if (state.ssh?.host && isPrivateIp(state.ssh.host)) return "tunnel";
      return "preferences";

    case "tunnel":
      // Edge tunnel with SSH → preferences; edge tunnel local → loading (complete)
      // Non-edge tunnel + SSH → preferences; non-edge tunnel local → loading
      if (state.tunnel?.provider === "edge") return "loading";
      if (!state.ssh) return "loading"; // local machine, no SSH
      return "preferences";

    case "preferences":
      return "loading";

    case "loading":
      return null; // done
  }
}

/**
 * Given the current step and collected state, determine the previous step.
 * Returns null if there's no back (first screen).
 */
export function prevStep(
  current: OnboardingStep,
  state: OnboardingState,
): OnboardingStep | null {
  switch (current) {
    case "choose":
      return null;

    case "selfhost-choice":
      return "choose";

    case "ssh":
      return "selfhost-choice";

    case "tunnel":
      // Came from SSH (remote private IP) or from selfhost-choice (local)
      if (state.hostingMode === "local") return "selfhost-choice";
      return "ssh";

    case "preferences":
      // Came from tunnel (LAN + non-edge) or directly from SSH (public IP)
      if (state.ssh?.host && isPrivateIp(state.ssh.host)) return "tunnel";
      return "ssh";

    case "loading":
      if (state.path === "cloud") return "choose";
      return "preferences";
  }
}
