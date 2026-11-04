import { Icon } from "@repo/ui/icons";

export function ChatAppsEmptyState() {
  return (
    <div className="rounded-2xl bg-card p-6 sm:p-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
        <svg
          viewBox="0 0 240 152"
          fill="none"
          aria-hidden="true"
          focusable="false"
          className="h-auto w-44 shrink-0 text-muted-foreground rtl:-scale-x-100"
        >
          <ellipse cx="120" cy="100" rx="110" ry="43" fill="var(--th-sf-03)" />
          <rect x="33" y="15" width="154" height="104" rx="14" fill="var(--th-sf-04)" />
          <rect
            x="24"
            y="24"
            width="154"
            height="104"
            rx="14"
            fill="var(--th-card-bg-solid)"
            stroke="var(--th-on-16)"
          />
          <path d="M25 50h152" stroke="var(--th-on-08)" />
          <g fill="var(--th-on-20)">
            <circle cx="38" cy="37" r="2" />
            <circle cx="46" cy="37" r="2" />
            <circle cx="54" cy="37" r="2" />
          </g>
          <rect x="38" y="64" width="124" height="31" rx="9" fill="var(--th-sf-04)" />
          <path
            d="m50 74 6 5-6 5m14-5h8m-31 29h62"
            stroke="var(--th-on-40)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M179 72h21v25"
            stroke="var(--th-on-20)"
            strokeWidth="1.5"
            strokeDasharray="3 4"
          />
          <rect
            x="155"
            y="97"
            width="68"
            height="44"
            rx="12"
            fill="var(--th-card-bg-solid)"
            stroke="var(--th-on-16)"
          />
          <Icon name="server" x="178" y="108" size="22" />
        </svg>
        <div>
          <h3 className="text-base font-medium text-foreground">
            Bring your deployments into the conversation
          </h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Check projects, redeploy and restart from your team’s chat. Choose an app above to get
            started.
          </p>
        </div>
      </div>
      <ol className="mt-6 grid gap-5 sm:grid-cols-3">
        {[
          ["Connect your bot", "Choose the conversations where commands are allowed."],
          ["Enable your bot", "Follow the app’s setup guide, then enable the connector."],
          ["Link your account", "Send /openship link and approve your own access."],
        ].map(([title, description], index) => (
          <li key={title} className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
              {index + 1}
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
