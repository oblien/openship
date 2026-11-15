import { capabilityArtwork } from "./capabilities";
import type { IllustrationArtwork } from "./IllustrationFrame";
import { INK, ACCENT, ACCENT_INK, CUTOUT, SURFACE } from "./palette";

/** Approved artwork. Keep this as the source for the app and generated previews. */
export const featureArtwork = {
  "compose-multi-service": (id) => (
    <>
      <defs>
        <mask
          id={`${id}-compose-cut`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="80"
          height="64"
        >
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <rect x="29" y="30" width="12" height="4" rx="2" fill="black" />
          <rect x="29" y="40" width="10" height="9" rx="2" fill="black" />
          <rect x="43" y="40" width="10" height="9" rx="2" fill="black" />
          <rect x="57" y="40" width="6" height="9" rx="2" fill="black" />
        </mask>
      </defs>
      <rect x="4" y="7" width="46" height="35" rx="8" fill={INK} opacity=".1" />
      <rect x="12" y="14" width="46" height="35" rx="8" fill={INK} opacity=".25" />
      <rect
        x="22"
        y="22"
        width="48"
        height="35"
        rx="8"
        fill={INK}
        mask={`url(#${id}-compose-cut)`}
      />
      <circle cx="68" cy="24" r="6" fill={ACCENT} />
      <path
        d="m65 24 2 2 4-4"
        fill="none"
        stroke={ACCENT_INK}
        strokeOpacity="1"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "managed-databases": (id) => (
    <>
      <defs>
        <mask id={`${id}-db-top-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="64">
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <circle cx="52" cy="13" r="2" fill="black" />
          <rect x="17" y="11.5" width="15" height="3" rx="1.5" fill="black" />
        </mask>
      </defs>
      <rect x="9" y="6" width="53" height="14" rx="6" fill={INK} mask={`url(#${id}-db-top-cut)`} />
      <rect x="9" y="25" width="53" height="14" rx="6" fill={INK} opacity=".52" />
      <rect x="9" y="44" width="53" height="14" rx="6" fill={INK} opacity=".21" />
      <path
        d="M17 32h15M17 51h15"
        fill="none"
        stroke={INK}
        strokeOpacity="0.8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M63 32h7v19H63"
        fill="none"
        stroke={INK}
        strokeOpacity="0.6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="70" cy="51" r="4" fill={ACCENT} />
    </>
  ),
  "domains-ssl": (id) => (
    <>
      <defs>
        <mask id={`${id}-domain-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="64">
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <circle cx="16" cy="32.5" r="6" fill="black" />
          <rect x="29" y="30" width="27" height="4" rx="2" fill="black" />
        </mask>
        <mask
          id={`${id}-domain-lock-cut`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="80"
          height="64"
        >
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <path d="M60 47v-3a5 5 0 0 1 10 0v3" fill="none" stroke="black" strokeWidth="2" />
          <rect x="58" y="47" width="14" height="8" rx="2" fill="black" />
        </mask>
      </defs>
      <circle cx="34" cy="31" r="24" fill="none" stroke={INK} strokeOpacity=".13" strokeWidth="1" />
      <rect x="3" y="20" width="72" height="25" rx="9" fill={INK} mask={`url(#${id}-domain-cut)`} />
      <circle cx="16" cy="32.5" r="4.7" fill="none" stroke={INK} strokeWidth="1" />
      <path
        d="M11.5 32.5h9M16 28v9"
        fill="none"
        stroke={INK}
        strokeOpacity="1"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="53"
        y="37"
        width="24"
        height="23"
        rx="8"
        fill={ACCENT}
        mask={`url(#${id}-domain-lock-cut)`}
      />
      <rect x="64" y="49" width="2" height="4" rx="1" fill={ACCENT} />
    </>
  ),
  "actions-ci": (id) => (
    <>
      <defs>
        <mask id={`${id}-ci-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="64">
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <path d="M37 25 47 32 37 39Z" fill="black" />
        </mask>
      </defs>
      <path
        d="M12 32h17m24 0h8V14h7M61 32v18h7"
        fill="none"
        stroke={INK}
        strokeOpacity="0.3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="32" r="5" fill={INK} opacity=".4" />
      <rect x="26" y="17" width="29" height="30" rx="10" fill={INK} mask={`url(#${id}-ci-cut)`} />
      <rect x="64" y="7" width="13" height="14" rx="4" fill={INK} opacity=".3" />
      <rect x="64" y="43" width="13" height="14" rx="4" fill={ACCENT} />
      <path
        d="m67 50 2 2 4-5"
        fill="none"
        stroke={ACCENT_INK}
        strokeOpacity="1"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "jobs-triggers": (id) => (
    <>
      <defs>
        <mask id={`${id}-jobs-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="64">
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <rect x="9" y="19" width="49" height="2" rx="0" fill="black" />
          <rect x="19" y="29" width="6" height="5" rx="1.5" fill="black" />
          <rect x="31" y="29" width="6" height="5" rx="1.5" fill="black" />
          <rect x="43" y="29" width="6" height="5" rx="1.5" fill="black" />
          <rect x="19" y="39" width="6" height="5" rx="1.5" fill="black" />
          <rect x="31" y="39" width="6" height="5" rx="1.5" fill="black" />
        </mask>
      </defs>
      <rect x="9" y="9" width="49" height="43" rx="9" fill={INK} mask={`url(#${id}-jobs-cut)`} />
      <rect x="19" y="4" width="4" height="10" rx="2" fill={INK} />
      <rect x="44" y="4" width="4" height="10" rx="2" fill={INK} />
      <circle cx="59" cy="47" r="14" fill={ACCENT} />
      <path
        d="M59 39v9l6 3"
        fill="none"
        stroke={ACCENT_INK}
        strokeOpacity="1"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="59" cy="47" r="1.8" fill={ACCENT_INK} />
    </>
  ),
  "ai-mcp": (id) => (
    <>
      <defs>
        <mask id={`${id}-ai-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="64">
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <circle cx="40" cy="32" r="7" fill="black" />
        </mask>
      </defs>
      <path
        d="M5 32h10M65 32h10"
        fill="none"
        stroke={INK}
        strokeOpacity="0.25"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5" cy="32" r="2" fill={INK} opacity=".35" />
      <circle cx="75" cy="32" r="3" fill={ACCENT} />
      <g mask={`url(#${id}-ai-cut)`}>
        <rect x="35" y="8" width="10" height="48" rx="5" fill={INK} transform="rotate(0 40 32)" />
        <rect x="35" y="8" width="10" height="48" rx="5" fill={INK} transform="rotate(60 40 32)" />
        <rect x="35" y="8" width="10" height="48" rx="5" fill={INK} transform="rotate(120 40 32)" />
      </g>
      <rect x="35" y="8" width="10" height="14" rx="5" fill={ACCENT} />
    </>
  ),
  "logs-monitoring": () => (
    <>
      <rect x="4" y="9" width="72" height="48" rx="9" fill={INK} opacity=".08" />
      <rect x="11" y="18" width="14" height="3" rx="1.5" fill={INK} opacity=".7" />
      <rect x="11" y="26" width="10" height="3" rx="1.5" fill={INK} opacity=".4" />
      <rect x="11" y="34" width="14" height="3" rx="1.5" fill={INK} opacity=".4" />
      <rect x="11" y="42" width="8" height="3" rx="1.5" fill={INK} opacity=".2" />
      <path
        d="M31 16v32M37 46h32"
        fill="none"
        stroke={INK}
        strokeOpacity="0.13"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M38 44v-9l7-9 7 8 9-16 8 8v18Z" fill={INK} opacity=".1" />
      <path
        d="m38 35 7-9 7 8 9-16 8 8"
        fill="none"
        stroke={INK}
        strokeOpacity="1"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="61" cy="18" r="3.5" fill={ACCENT} />
    </>
  ),
  "backups-restore": (id) => (
    <>
      <defs>
        <mask
          id={`${id}-backups-cut`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="80"
          height="64"
        >
          <rect x="0" y="0" width="80" height="64" rx="0" fill="white" />
          <rect x="20" y="27" width="22" height="3" rx="1.5" fill="black" />
          <rect x="20" y="35" width="16" height="3" rx="1.5" fill="black" />
        </mask>
      </defs>
      <rect x="23" y="4" width="43" height="42" rx="8" fill={INK} opacity=".12" />
      <rect x="17" y="11" width="43" height="42" rx="8" fill={INK} opacity=".28" />
      <rect
        x="11"
        y="18"
        width="43"
        height="42"
        rx="8"
        fill={INK}
        mask={`url(#${id}-backups-cut)`}
      />
      <circle cx="61" cy="46" r="14" fill={SURFACE} />
      <path
        d="M52 46a9 9 0 1 1 9 9m-9-16v7h7"
        fill="none"
        stroke={ACCENT}
        strokeOpacity="1"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "instant-rollbacks": () => (
    <>
      <rect x="29" y="6" width="46" height="12" rx="5" fill={INK} opacity=".2" />
      <rect x="25" y="26" width="46" height="12" rx="5" fill={INK} />
      <rect x="29" y="46" width="46" height="12" rx="5" fill={INK} opacity=".2" />
      <path
        d="M18 51C1 51 1 12 18 12h6"
        fill="none"
        stroke={INK}
        strokeOpacity="0.65"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18 6 25 12 18 18Z" fill={ACCENT} />
      <circle cx="33" cy="32" r="2.5" fill={CUTOUT} />
      <rect x="40" y="30.5" width="17" height="3" rx="1.5" fill={CUTOUT} />
    </>
  ),
  ...capabilityArtwork,
} satisfies Record<string, IllustrationArtwork>;

export type FeatureIllustrationName = keyof typeof featureArtwork;
