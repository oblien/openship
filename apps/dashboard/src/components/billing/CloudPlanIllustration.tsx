import { useId } from "react";
import { cn } from "@/lib/utils";

/** App-to-cloud vignette in the same fine-line style as the home empty state. */
export function CloudPlanIllustration({
  subscribed = false,
  className,
}: {
  subscribed?: boolean;
  className?: string;
}) {
  const washId = useId();

  return (
    <svg
      viewBox="0 0 224 112"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("pointer-events-none block h-auto w-56 max-w-full select-none", className)}
    >
      <defs>
        <linearGradient id={washId} x1="30" y1="40" x2="196" y2="88" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--th-btn-accent-from)" stopOpacity="0.07" />
          <stop offset="1" stopColor="var(--th-btn-accent-to)" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      <ellipse cx="113" cy="67" rx="88" ry="35" fill={`url(#${washId})`} />

      {/* A small cloud sits behind the app, connected by the same dashed wiring as HomeWelcome. */}
      <path
        d="M148 51h30c8 0 14-6 14-13 0-7-5-12-12-13-2-9-10-15-19-13-9 1-15 8-16 16-6 0-11 5-11 11 0 7 6 12 14 12Z"
        fill="var(--th-card-bg)"
        stroke="var(--th-on-30)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M144 76h18a10 10 0 0 0 10-10v-9" stroke="var(--th-on-20)" strokeWidth="1.25" strokeDasharray="3 4" strokeLinecap="round" />

      {/* Layered app preview, with a small Openship ring and muted content lines. */}
      <rect x="52" y="32" width="98" height="58" rx="11" fill="var(--th-sf-03)" stroke="var(--th-on-08)" />
      <rect x="43" y="40" width="98" height="58" rx="11" fill="var(--th-card-bg)" stroke="var(--th-on-16)" />
      <path d="M44 54h96" stroke="var(--th-on-08)" />
      <g fill="var(--th-on-25)">
        <circle cx="54" cy="47" r="1.5" />
        <circle cx="60" cy="47" r="1.5" />
        <circle cx="66" cy="47" r="1.5" />
      </g>
      <circle cx="65" cy="76" r="11" fill="var(--th-sf-03)" />
      <circle cx="65" cy="76" r="7" stroke="var(--th-on-40)" strokeWidth="1.6" />
      <rect x="86" y="68" width="35" height="3" rx="1.5" fill="var(--th-on-16)" />
      <rect x="86" y="76" width="26" height="3" rx="1.5" fill="var(--th-on-08)" />
      <rect x="86" y="84" width="19" height="3" rx="1.5" fill="var(--th-on-08)" />

      <circle cx="28" cy="48" r="2.5" fill="var(--th-on-08)" />
      <path d="M198 65v6m-3-3h6" stroke="var(--th-on-20)" strokeWidth="1.25" strokeLinecap="round" />
      {subscribed ? (
        <g>
          <circle cx="172" cy="75" r="12" fill="var(--th-card-bg-solid)" />
          <circle cx="172" cy="75" r="10" fill="var(--st-success-bg)" />
          <path d="m168 75 3 3 5-6" stroke="var(--st-success-fg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : (
        <circle cx="161" cy="76" r="2.5" fill="var(--th-btn-accent-from)" fillOpacity="0.6" />
      )}
    </svg>
  );
}
