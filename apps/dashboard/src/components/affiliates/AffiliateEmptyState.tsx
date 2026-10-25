import type { ReactNode } from "react";
import { Icon } from "@repo/ui/icons";

/** The same neutral, layered-card illustration family used by Actions and Backups. */
function AffiliateIllustration({ kind }: { kind: "links" | "customers" | "payouts" }) {
  return (
    <svg
      viewBox="0 0 280 160"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none h-auto w-64 max-w-full select-none text-muted-foreground rtl:-scale-x-100"
    >
      <ellipse cx="140" cy="100" rx="112" ry="48" fill="var(--th-sf-03)" />
      <path
        d="M51 82H29m201 0h22M224 118h17"
        stroke="var(--th-on-12)"
        strokeDasharray="3 5"
        strokeLinecap="round"
      />
      <rect
        x="70"
        y="16"
        width="146"
        height="106"
        rx="14"
        fill="var(--th-sf-04)"
        stroke="var(--th-on-08)"
      />
      <rect
        x="61"
        y="25"
        width="146"
        height="106"
        rx="14"
        fill="var(--th-sf-05)"
        stroke="var(--th-on-12)"
      />
      <rect
        x="52"
        y="34"
        width="146"
        height="106"
        rx="14"
        fill="var(--th-card-bg-solid)"
        stroke="var(--th-on-20)"
      />
      <path d="M53 57h144" stroke="var(--th-on-08)" />
      <g fill="var(--th-on-25)">
        <circle cx="66" cy="46" r="2" />
        <circle cx="74" cy="46" r="2" />
        <circle cx="82" cy="46" r="2" />
      </g>
      {kind === "links" ? (
        <>
          <rect x="68" y="72" width="114" height="28" rx="8" fill="var(--th-sf-04)" />
          <Icon name="link" x="77" y="78" size="16" />
          <path
            d="M101 86h64M69 115h63M69 124h43"
            stroke="var(--th-on-16)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      ) : kind === "customers" ? (
        <>
          {[77, 108].map((y) => (
            <g key={y}>
              <circle cx="80" cy={y + 7} r="11" fill="var(--th-sf-05)" />
              <Icon name="user" x="73" y={y} size="14" />
              <path
                d={`M101 ${y + 3}h58m-58 8h35`}
                stroke="var(--th-on-16)"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </g>
          ))}
        </>
      ) : (
        <>
          <Icon name="credit-card" x="69" y="75" size="22" />
          <path
            d="M104 80h58m-58 10h35M70 112h91m-91 11h58"
            stroke="var(--th-on-16)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )}
      <path
        d="M198 87h15a13 13 0 0 1 13 13v5"
        stroke="var(--th-on-20)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        strokeLinecap="round"
      />
      <circle cx="224" cy="122" r="23" fill="var(--th-card-bg-solid)" stroke="var(--th-on-16)" />
      <Icon
        name={kind === "links" ? "users" : kind === "customers" ? "link" : "clock"}
        x="213"
        y="111"
        size="22"
      />
      <circle cx="31" cy="114" r="3" fill="var(--th-on-10)" />
      <path d="M242 43v6m-3-3h6" stroke="var(--th-on-20)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function AffiliateEmptyState({
  kind = "links",
  title,
  description,
  action,
}: {
  kind?: "links" | "customers" | "payouts";
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col items-center rounded-2xl bg-card px-6 py-10 text-center sm:py-12">
      <AffiliateIllustration kind={kind} />
      <h2 className="mt-5 text-xl font-medium tracking-tight">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-6 flex flex-wrap justify-center gap-2">{action}</div>}
    </section>
  );
}
