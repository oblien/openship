/* ── Coming soon — advanced infra from the dashboard ── */

const ROADMAP = [
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0012 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 01-2.031.352 5.988 5.988 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 01-2.031.352 5.989 5.989 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971z" />
      </svg>
    ),
    title: "Load balancer setup",
    desc: "Visual load balancer configuration right from the app. Route traffic across containers with weighted rules, health checks, and sticky sessions — no HAProxy or NGINX configs.",
    tag: "Infrastructure",
    color: "var(--th-clr-plum)",
    bg: "var(--th-clr-plum-bg)",
    blob: "var(--th-clr-plum-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
      </svg>
    ),
    title: "Cluster management",
    desc: "Create and manage multi-node clusters from one screen. Add worker nodes, distribute services, view cluster health — all through the app. Scale horizontally in seconds.",
    tag: "Scaling",
    color: "var(--th-clr-sea)",
    bg: "var(--th-clr-sea-bg)",
    blob: "var(--th-clr-sea-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-3.811a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
      </svg>
    ),
    title: "Private networking",
    desc: "Encrypted service-to-service communication with visual network topology. Define VLANs, private subnets, and firewall rules between containers — all from a drag-and-drop interface.",
    tag: "Networking",
    color: "var(--th-clr-terra)",
    bg: "var(--th-clr-terra-bg)",
    blob: "var(--th-clr-terra-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
      </svg>
    ),
    title: "Advanced monitoring",
    desc: "Custom metric dashboards, alerting rules, anomaly detection powered by AI. Set thresholds, get notified on Slack/Discord/email before problems become outages.",
    tag: "Observability",
    color: "var(--th-clr-plum)",
    bg: "var(--th-clr-plum-bg)",
    blob: "var(--th-clr-plum-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
      </svg>
    ),
    title: "CI/CD pipelines",
    desc: "Visual pipeline builder inside the app. Drag-and-drop build stages, run tests, deploy to staging then production — with automatic rollback on failure.",
    tag: "DevOps",
    color: "var(--th-clr-sea)",
    bg: "var(--th-clr-sea-bg)",
    blob: "var(--th-clr-sea-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
    title: "Secrets & vault",
    desc: "Encrypted secrets manager with team-scoped access controls, audit logs, and automatic rotation. Environment variables, API keys, and certificates — all in one secure vault.",
    tag: "Security",
    color: "var(--th-clr-terra)",
    bg: "var(--th-clr-terra-bg)",
    blob: "var(--th-clr-terra-blob)",
  },
];

export function ComingSoon() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ background: "var(--th-clr-plum-soft)" }} />
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "var(--th-clr-plum)" }} />
            </span>
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Coming Soon
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Enterprise-grade infra.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              All from the app.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            We&apos;re building the tools teams actually need for real scale —
            load balancers, clusters, private networking, and advanced monitoring.
            All managed visually in the app, no infrastructure degree required.
          </p>
        </div>

        {/* ── Feature cards ── */}
        <div className="mx-auto mt-16 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {ROADMAP.map((item) => (
            <div
              key={item.title}
              className="group relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-7 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              {/* Ambient blob */}
              <div
                className="pointer-events-none absolute -right-12 -top-12 h-[160px] w-[160px] rounded-full blur-[60px] transition-opacity duration-300 group-hover:opacity-100 opacity-60"
                style={{ background: item.blob }}
              />

              <div className="relative">
                {/* Icon + tag */}
                <div className="mb-5 flex items-center justify-between">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-xl"
                    style={{ background: item.bg, color: item.color }}
                  >
                    {item.icon}
                  </div>
                  <span
                    className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]"
                    style={{ background: item.bg, color: item.color }}
                  >
                    {item.tag}
                  </span>
                </div>

                <h3 className="text-[18px] font-bold leading-tight tracking-tight th-text-heading">
                  {item.title}
                </h3>
                <p className="mt-2.5 text-[13px] leading-[1.65] th-text-body">
                  {item.desc}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Bottom ribbon ── */}
        <div className="mx-auto mt-12 max-w-3xl text-center">
          <div className="inline-flex items-center gap-3 rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] px-6 py-4 shadow-[var(--th-card-shadow)]">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: "var(--th-clr-sea-bg)", color: "var(--th-clr-sea)" }}>
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
            </div>
            <div className="text-left">
              <p className="text-[14px] font-semibold th-text-heading">Want early access?</p>
              <p className="text-[12px] th-text-muted">Join the waitlist — these ship quarterly.</p>
            </div>
            <a href="https://app.openship.io" className="ml-3 th-btn rounded-full px-5 py-2 text-[13px] font-medium">
              Notify me
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
