"use client";

/**
 * Binary on/off switch — the shared toggle trigger used for the server git
 * credential-forwarding opt-in and the port-forwarding "open on startup"
 * controls, so they look and behave identically. (For multi-option segmented
 * controls use SlidingToggle instead.)
 */
interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  /** Accessible label (the visible label usually sits next to the switch). */
  ariaLabel?: string;
  /** Extra classes on the track (alignment inside a row, etc.). */
  className?: string;
}

const DIMS = {
  sm: {
    track: "h-4 w-7",
    knob: "size-3",
    on: "translate-x-3.5 rtl:-translate-x-3.5",
    off: "translate-x-0.5 rtl:-translate-x-0.5",
  },
  md: {
    track: "h-5 w-9",
    knob: "size-4",
    on: "translate-x-[18px] rtl:-translate-x-[18px]",
    off: "translate-x-0.5 rtl:-translate-x-0.5",
  },
  // Settings-row scale — the size the settings tabs and modal switches used
  // before they shared this component.
  lg: {
    track: "h-6 w-11",
    knob: "size-5",
    on: "translate-x-[22px] rtl:-translate-x-[22px]",
    off: "translate-x-0.5 rtl:-translate-x-0.5",
  },
} as const;

export function Switch({
  checked,
  onChange,
  disabled = false,
  size = "md",
  ariaLabel,
  className = "",
}: SwitchProps) {
  // `transform: translateX` is NOT auto-mirrored under dir="rtl", so each
  // position gets an `rtl:-translate-x-*` counterpart — the knob rests at the
  // (flex-start) trailing edge and slides the opposite way in Arabic.
  //
  // The knob is `bg-background`, NOT bg-white: `--primary` is white in the dark
  // themes, so a white knob on the checked track is invisible there. Every copy of
  // this control that hardcoded white had that bug.
  const dims = DIMS[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex ${dims.track} shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      } ${className}`}
    >
      <span
        className={`inline-block ${dims.knob} transform rounded-full bg-background shadow-sm transition-transform ${
          checked ? dims.on : dims.off
        }`}
      />
    </button>
  );
}
