/** Decorative app → conversation → notification flow, using the shared empty-state surfaces. */
export function AssistantIllustration() {
  return (
    <svg
      viewBox="0 0 560 240"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none h-auto w-full select-none"
    >
      <ellipse cx="281" cy="200" rx="176" ry="22" fill="var(--th-sf-03)" />

      {/* Dashed connectors follow the Projects and Backups illustrations. */}
      <path
        d="M126 141h14c16 0 14-14 30-14M390 126h14c18 0 15-25 33-25"
        stroke="var(--th-on-20)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        strokeLinecap="round"
      />

      {/* Neutral layered product window. */}
      <rect x="194" y="64" width="220" height="158" rx="20" fill="var(--th-sf-04)" />
      <rect
        x="182"
        y="54"
        width="220"
        height="158"
        rx="20"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-subtle)"
      />
      <rect
        x="170"
        y="44"
        width="220"
        height="158"
        rx="20"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <path d="M190 44h180a20 20 0 0 1 20 20v11H170V64a20 20 0 0 1 20-20Z" fill="var(--th-sf-03)" />
      <circle cx="187" cy="60" r="2.5" fill="var(--th-on-20)" />
      <circle cx="197" cy="60" r="2.5" fill="var(--th-on-16)" />
      <circle cx="207" cy="60" r="2.5" fill="var(--th-on-12)" />
      <rect x="339" y="57" width="33" height="6" rx="3" fill="var(--th-on-08)" />

      <path
        d="M282 88h79a12 12 0 0 1 12 12v19l-12-7h-79a12 12 0 0 1 0-24Z"
        fill="var(--th-sf-05)"
      />
      <path d="M286 100h68" stroke="var(--th-on-25)" strokeWidth="3.5" strokeLinecap="round" />
      <path
        d="M201 125c0 9-4 13-13 13 9 0 13 4 13 13 0-9 4-13 13-13-9 0-13-4-13-13Z"
        fill="var(--st-info-fg)"
        fillOpacity=".65"
      />
      <path d="M224 133h131" stroke="var(--th-on-40)" strokeWidth="4" strokeLinecap="round" />
      <path
        d="M224 145h107m-107 12h75"
        stroke="var(--th-on-20)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <rect x="223" y="177" width="66" height="17" rx="6" fill="var(--th-sf-05)" />
      <path d="M233 185.5h44" stroke="var(--th-on-25)" strokeWidth="2.5" strokeLinecap="round" />
      <rect x="296" y="177" width="43" height="17" rx="6" fill="var(--th-sf-03)" />
      <path d="M305 185.5h25" stroke="var(--th-on-12)" strokeWidth="2.5" strokeLinecap="round" />

      {/* App deployments. */}
      <rect
        x="32"
        y="95"
        width="94"
        height="94"
        rx="24"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <path d="m52 151 27-13 27 13-27 14-27-14Z" fill="var(--th-on-06)" />
      <path d="m52 143 27-13 27 13-27 14-27-14Z" fill="var(--th-on-12)" />
      <path d="m52 132 27-14 27 14v9l-27 14-27-14v-9Z" fill="var(--th-on-25)" />
      <path d="m52 132 27 14 27-14M79 146v9" stroke="var(--th-card-on-page)" strokeWidth="1.3" />
      <path d="m69 131 10 5 10-5-10-5-10 5Z" fill="var(--th-on-40)" />

      {/* A reply delivered to chat. */}
      <rect
        x="437"
        y="54"
        width="94"
        height="94"
        rx="24"
        fill="var(--th-card-on-page)"
        stroke="var(--th-bd-default)"
      />
      <path
        d="M481 87h25a9 9 0 0 1 9 9v18a9 9 0 0 1-9 9h-3l-8 7v-7h-14a9 9 0 0 1-9-9V96a9 9 0 0 1 9-9Z"
        fill="var(--th-on-08)"
      />
      <path
        d="M462 77h33a10 10 0 0 1 10 10v16a10 10 0 0 1-10 10h-21l-12 9v-9a10 10 0 0 1-10-10V87a10 10 0 0 1 10-10Z"
        fill="var(--th-on-25)"
      />
      <path
        d="M463 91h30m-30 8h19"
        stroke="var(--th-card-on-page)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <g fill="var(--th-on-25)">
        <circle cx="126" cy="141" r="3" />
        <circle cx="170" cy="127" r="3" />
        <circle cx="390" cy="126" r="3" />
        <circle cx="437" cy="101" r="3" />
      </g>

      <circle cx="119" cy="63" r="3" fill="var(--th-on-12)" />
      <circle cx="45" cy="207" r="4" fill="var(--th-on-06)" />
      <path
        d="M424 184v8m-4-4h8"
        stroke="var(--th-on-16)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
