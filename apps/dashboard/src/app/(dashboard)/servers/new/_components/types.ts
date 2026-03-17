import type { ComponentStatus } from "@/lib/api/system";

export type SetupMode = "auto" | "manual" | null;
export type Step = "choose" | "checking" | "results" | "installing";

export interface ComponentState {
  name: string;
  label: string;
  description: string;
  status: ComponentStatus | null;
  installState: "idle" | "installing" | "installed" | "failed";
  installError?: string;
}
