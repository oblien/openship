/**
 * The canonical install-phase backbone — the ordered, named stages a catalog-app
 * install moves through, shared by the API (which emits phase-boundary events) and
 * the dashboard (which renders them as a stepper). Defined here in @repo/core, NOT
 * in @repo/adapters alongside the fixed `BuildStep` union, on purpose: this is a
 * PARALLEL channel to the low-level build steps. `BuildStep` is a fixed 5-value
 * enum whose `deploy` step fires several times (once at the compose level + once
 * per service) — unusable as a stepper source. These phases fire exactly once per
 * boundary, carry a richer status, and never touch the build-step/progress model.
 */

/** One stage in the install. `app-setup` is present only when the app declares
 *  prepare steps; `images` is `skipped` for pull-only apps (no image to build). */
export type InstallPhaseId = "images" | "services" | "app-setup" | "ready";

/**
 * A phase's live state. Richer than the SSE terminal status (which collapses
 * reconciling/partial_failure to ready+warning) — so `failed` here is what
 * carries the precise "which phase broke" signal the terminal event can't.
 */
export type InstallPhaseStatus = "pending" | "active" | "done" | "skipped" | "failed";

export interface InstallPhaseEvent {
  id: InstallPhaseId;
  status: InstallPhaseStatus;
  /** Optional authored/override label; the renderer falls back to `defaultLabel`. */
  label?: string;
}

export const INSTALL_PHASES: readonly { id: InstallPhaseId; defaultLabel: string }[] = [
  { id: "images", defaultLabel: "Preparing images" },
  { id: "services", defaultLabel: "Starting services" },
  { id: "app-setup", defaultLabel: "Finishing setup" },
  { id: "ready", defaultLabel: "Live" },
];
