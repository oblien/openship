import { useId } from "react";

/** Decorative workflow/runner preview, using the same surfaces as our empty states. */
export function ActionsIllustration({
  kind = "workflow",
  className,
}: {
  kind?: "workflow" | "runner" | "history";
  className?: string;
}) {
  const id = useId();
  const runner = kind === "runner";
  return (
    <svg
      viewBox="0 0 440 256"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern id={`${id}-grid`} width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="var(--th-on-12)" />
        </pattern>
        <radialGradient id={`${id}-fade`}>
          <stop offset="0.35" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </radialGradient>
        <mask id={`${id}-mask`}>
          <rect width="440" height="256" fill={`url(#${id}-fade)`} />
        </mask>
      </defs>

      <rect width="440" height="256" fill={`url(#${id}-grid)`} mask={`url(#${id}-mask)`} />
      <ellipse cx="211" cy="211" rx="153" ry="17" fill="var(--th-sf-03)" />

      {/* Layered source window. */}
      <rect x="91" y="61" width="230" height="150" rx="17" fill="var(--th-sf-04)" />
      <rect
        x="80"
        y="48"
        width="230"
        height="150"
        rx="17"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-subtle)"
      />
      <rect
        x="68"
        y="35"
        width="230"
        height="150"
        rx="17"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <path d="M85 35h196a17 17 0 0 1 17 17v17H68V52a17 17 0 0 1 17-17Z" fill="var(--th-sf-03)" />
      <circle cx="85" cy="52" r="3" fill="var(--th-on-20)" />
      <circle cx="97" cy="52" r="3" fill="var(--th-on-12)" />
      <circle cx="109" cy="52" r="3" fill="var(--th-on-08)" />
      <rect x="216" y="48" width="62" height="7" rx="3.5" fill="var(--th-on-08)" />

      {runner ? (
        <>
          {[87, 119, 151].map((y, index) => (
            <g key={y}>
              <rect
                x="87"
                y={y}
                width="174"
                height="23"
                rx="6"
                fill="var(--th-sf-03)"
                stroke="var(--th-bd-subtle)"
              />
              <circle
                cx="100"
                cy={y + 11.5}
                r="3"
                fill={index === 0 ? "var(--st-success-fg)" : "var(--th-on-20)"}
              />
              <path
                d={`M113 ${y + 11.5}h44`}
                stroke="var(--th-on-16)"
                strokeWidth="4"
                strokeLinecap="round"
              />
              <path
                d={`M228 ${y + 8}v7m8-7v7m8-7v7`}
                stroke="var(--th-on-20)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </g>
          ))}
        </>
      ) : (
        <>
          {/* A YAML file feeding a small dependency graph. */}
          <path
            d="m88 88 5 4-5 4m13-4h15"
            stroke="var(--st-info-fg)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="126" y="89" width="73" height="5" rx="2.5" fill="var(--th-on-25)" />
          <path d="M95 111v42" stroke="var(--th-on-10)" strokeWidth="1.5" />
          <rect x="105" y="109" width="53" height="5" rx="2.5" fill="var(--th-on-12)" />
          <rect x="105" y="124" width="87" height="5" rx="2.5" fill="var(--th-on-08)" />
          <rect x="116" y="139" width="66" height="5" rx="2.5" fill="var(--th-on-12)" />
          <rect x="116" y="154" width="92" height="5" rx="2.5" fill="var(--th-on-08)" />
        </>
      )}

      {/* Connected jobs: real UI motifs, without fabricated run statistics. */}
      <path
        d="M298 114h19a14 14 0 0 0 14-14V84m-33 30h19a14 14 0 0 1 14 14v23"
        stroke="var(--th-on-16)"
        strokeWidth="1.5"
      />
      <circle
        cx="298"
        cy="114"
        r="4"
        fill="var(--th-card-on-page)"
        stroke="var(--th-on-20)"
        strokeWidth="1.5"
      />
      <rect
        x="307"
        y="43"
        width="87"
        height="42"
        rx="12"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <rect x="319" y="55" width="18" height="18" rx="5" fill="var(--st-success-bg)" />
      <path
        d="m324 64 3 3 5-6"
        stroke="var(--st-success-fg)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="345" y="59" width="33" height="4" rx="2" fill="var(--th-on-25)" />
      <rect x="345" y="67" width="23" height="3" rx="1.5" fill="var(--th-on-08)" />

      <rect
        x="307"
        y="151"
        width="87"
        height="42"
        rx="12"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <rect x="319" y="163" width="18" height="18" rx="5" fill="var(--st-info-bg)" />
      {kind === "history" ? (
        <>
          <circle cx="328" cy="172" r="5" stroke="var(--st-info-fg)" strokeWidth="1.5" />
          <path
            d="M328 169v3l2 1"
            stroke="var(--st-info-fg)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      ) : (
        <path d="m326 168 5 4-5 4v-8Z" fill="var(--st-info-fg)" />
      )}
      <rect x="345" y="167" width="29" height="4" rx="2" fill="var(--th-on-25)" />
      <rect x="345" y="175" width="19" height="3" rx="1.5" fill="var(--th-on-08)" />

      {/* Source badge and a compact completed step in front of the window. */}
      <rect
        x="36"
        y="97"
        width="52"
        height="52"
        rx="14"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <path
        d="M55 116v16m0-8h7a8 8 0 0 0 8-8"
        stroke="var(--th-on-40)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle
        cx="55"
        cy="113"
        r="3"
        fill="var(--th-card-on-page)"
        stroke="var(--th-on-40)"
        strokeWidth="2"
      />
      <circle
        cx="55"
        cy="135"
        r="3"
        fill="var(--th-card-on-page)"
        stroke="var(--th-on-40)"
        strokeWidth="2"
      />
      <circle
        cx="70"
        cy="113"
        r="3"
        fill="var(--th-card-on-page)"
        stroke="var(--th-on-40)"
        strokeWidth="2"
      />
      <rect
        x="160"
        y="178"
        width="123"
        height="39"
        rx="12"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <circle cx="181" cy="197.5" r="10" fill="var(--st-success-bg)" />
      <path
        d="m177 198 3 3 5-6"
        stroke="var(--st-success-fg)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="200" y="191" width="64" height="5" rx="2.5" fill="var(--th-on-25)" />
      <rect x="200" y="201" width="42" height="4" rx="2" fill="var(--th-on-08)" />
    </svg>
  );
}
