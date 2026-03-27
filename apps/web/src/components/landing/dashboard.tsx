const CAPABILITIES = [
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    title: "One-click deploys",
    desc: "Push, preview, promote — all from a single screen.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
    title: "Domains & SSL",
    desc: "Add domains, wildcard certs auto-provision. Visual DNS status.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
    title: "Real-time monitoring",
    desc: "CPU, memory, network, build logs — live charts and streaming.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
    title: "Databases & services",
    desc: "Spin up Postgres, Redis, or any Docker service. Visual management.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
      </svg>
    ),
    title: "Backups & rollback",
    desc: "Scheduled snapshots, one-click restore. Never lose a deployment.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
      </svg>
    ),
    title: "Auto-scale controls",
    desc: "Toggle auto-scaling per project from the app. Visual resource graphs.",
  },
];

/* ── AI assistant capabilities ── */
const AI_FEATURES = [
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
    title: "AI deploys for you",
    desc: "Tell the AI what you want deployed and it handles repo connection, build config, environment variables, and domain setup — start to finish.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
    title: "Security fully configured",
    desc: "Firewall rules, SSL, rate limiting, CORS, headers — the AI configures production-grade security by default. Disable anything you don't need with one toggle.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.19A1.5 1.5 0 016 10.68V6.757a1.5 1.5 0 01.788-1.32l4.723-2.574a1.5 1.5 0 011.478 0l4.723 2.573a1.5 1.5 0 01.788 1.32v3.924a1.5 1.5 0 01-.036.301M11.42 15.17l4.543 2.69a1.5 1.5 0 001.478 0l4.723-2.573a1.5 1.5 0 00.788-1.32v-3.924a1.5 1.5 0 00-.788-1.32l-4.723-2.573a1.5 1.5 0 00-1.478 0L11.42 9.47m0 5.7v5.373m0 0l-4.723-2.574a1.5 1.5 0 01-.788-1.32v-3.923" />
      </svg>
    ),
    title: "Zero-knowledge setup",
    desc: "Don't know Docker, NGINX, or DNS? You don't need to. Describe your app in plain English and the AI sets up everything — databases, caching, domains, backups.",
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.75h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z" />
      </svg>
    ),
    title: "Auto-diagnose & fix",
    desc: "Build failed? AI reads the logs, identifies the issue, and applies the fix automatically. You approve or let it run hands-free.",
  },
];

export function Dashboard() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              The App
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Full control.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              One beautiful app.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            Deployments, domains, databases, backups, scaling — manage your entire
            infrastructure from one app. Desktop, web, or CLI — your call. No YAML, no guesswork.
          </p>
        </div>

        {/* ── Screenshot ── */}
        <div className="mx-auto mt-14 max-w-6xl">
          <div className="relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[0_8px_40px_rgba(0,0,0,.08)]">
            {/* Fake browser chrome */}
            <div className="flex items-center gap-2 border-b border-[var(--th-card-bd)] bg-[var(--th-sf-02)] px-4 py-2.5">
              <div className="flex gap-1.5">
                <div className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--th-clr-terra)" }} />
                <div className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--th-clr-amber)" }} />
                <div className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--th-clr-sea)" }} />
              </div>
              <div className="ml-4 flex-1 rounded-md bg-[var(--th-sf-04)] px-3 py-1 text-[12px] th-text-muted">
                Openship — Connected to 192.168.1.100
              </div>
            </div>

            {/* Dashboard mockup content */}
            <div className="grid grid-cols-[200px_1fr] min-h-[420px]">
              {/* Sidebar */}
              <div className="border-r border-[var(--th-card-bd)] bg-[var(--th-sf-01)] p-4">
                <div className="mb-6 text-[14px] font-bold th-text-heading">Openship</div>
                {["Projects", "Deployments", "Domains", "Databases", "Backups", "Settings"].map(
                  (item, i) => (
                    <div
                      key={item}
                      className="mb-1 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors"
                      style={{
                        background: i === 0 ? "var(--th-sf-05)" : "transparent",
                        color:
                          i === 0
                            ? "var(--th-text-heading)"
                            : "var(--th-text-muted)",
                      }}
                    >
                      {item}
                    </div>
                  )
                )}
              </div>

              {/* Main area */}
              <div className="p-6">
                <div className="mb-5 flex items-center justify-between">
                  <div className="text-[18px] font-bold th-text-heading">Projects</div>
                  <div className="rounded-lg px-3 py-1.5 text-[12px] font-semibold" style={{ background: "var(--th-btn-bg)", color: "var(--th-btn-text)" }}>
                    + New Project
                  </div>
                </div>

                {/* Project cards row */}
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { name: "my-saas-app", status: "Live", framework: "Next.js", deploys: 42 },
                    { name: "api-service", status: "Live", framework: "Node.js", deploys: 18 },
                    { name: "landing-page", status: "Building", framework: "Astro", deploys: 7 },
                  ].map((p) => (
                    <div
                      key={p.name}
                      className="rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-4"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[14px] font-semibold th-text-heading">
                          {p.name}
                        </span>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                          style={{
                            background:
                              p.status === "Live"
                                ? "var(--th-clr-sea-wash)"
                                : "var(--th-clr-amber-wash)",
                            color:
                              p.status === "Live"
                                ? "var(--th-clr-sea)"
                                : "var(--th-text-secondary)",
                          }}
                        >
                          {p.status}
                        </span>
                      </div>
                      <div className="mt-2 text-[12px] th-text-muted">
                        {p.framework} · {p.deploys} deploys
                      </div>
                      {/* Mini bar chart */}
                      <div className="mt-3 flex items-end gap-px h-6">
                        {Array.from({ length: 12 }).map((_, j) => (
                          <div
                            key={j}
                            className="flex-1 rounded-sm"
                            style={{
                              height: `${20 + Math.sin(j * 0.8 + p.deploys) * 40 + 40}%`,
                              background:
                                p.status === "Live"
                                  ? "var(--th-clr-sea-bg)"
                                  : "var(--th-clr-amber-wash)",
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Stats ribbon */}
                <div className="mt-4 grid grid-cols-4 gap-3">
                  {[
                    { label: "Total deploys", val: "67" },
                    { label: "Active domains", val: "12" },
                    { label: "Uptime", val: "99.98%" },
                    { label: "Avg build", val: "34s" },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="rounded-lg border border-[var(--th-card-bd)] bg-[var(--th-sf-01)] p-3 text-center"
                    >
                      <div className="text-[18px] font-bold th-text-heading">
                        {s.val}
                      </div>
                      <div className="text-[11px] th-text-muted">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Capability grid ── */}
        <div className="mx-auto mt-14 grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="group flex items-start gap-4 rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-5 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                style={{ background: "var(--th-clr-plum-bg)", color: "var(--th-clr-plum)" }}
              >
                {c.icon}
              </div>
              <div>
                <h3 className="text-[15px] font-semibold th-text-heading">
                  {c.title}
                </h3>
                <p className="mt-1 text-[13px] leading-[1.55] th-text-body">
                  {c.desc}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── AI Assistant ── */}
        <div className="mx-auto mt-20 max-w-6xl">
          {/* Sub-heading */}
          <div className="mx-auto mb-10 max-w-3xl text-center">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
              <svg className="h-3.5 w-3.5 th-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
              <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
                Built-in AI Assistant
              </span>
            </div>
            <h3 className="text-[clamp(1.75rem,4vw,2.75rem)] font-semibold leading-[1.1] tracking-[-0.03em] th-text-heading">
              Don&apos;t know how?{" "}
              <span style={{ color: "var(--th-on-40)" }}>AI does it for you.</span>
            </h3>
            <p className="mx-auto mt-5 max-w-xl text-[16px] leading-[1.65] th-text-body">
              An AI assistant lives inside the app. It can deploy apps, configure security,
              set up databases, fix failed builds, and manage domains — all by just telling it what you want.
              Zero DevOps knowledge required. Disable it anytime.
            </p>
          </div>

          {/* AI Chat mockup */}
          <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[0_8px_40px_rgba(0,0,0,.08)]">
            {/* Chat header */}
            <div className="flex items-center gap-3 border-b border-[var(--th-card-bd)] bg-[var(--th-sf-02)] px-5 py-3">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "var(--th-clr-plum-bg)", color: "var(--th-clr-plum)" }}>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <span className="text-[13px] font-semibold th-text-heading">Openship AI</span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--th-clr-sea)" }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--th-clr-sea)" }} />
                Online
              </span>
            </div>
            {/* Chat messages */}
            <div className="space-y-4 p-5">
              {/* User message */}
              <div className="flex justify-end">
                <div className="max-w-[75%] rounded-2xl rounded-tr-md bg-[var(--th-sf-04)] px-4 py-2.5 text-[13px] leading-[1.6] th-text-heading">
                  Deploy my Next.js app from github.com/acme/store, set up Postgres, configure SSL for store.acme.com, and enable daily backups.
                </div>
              </div>
              {/* AI response */}
              <div className="flex justify-start">
                <div className="max-w-[80%] space-y-3 rounded-2xl rounded-tl-md border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] px-4 py-3 shadow-sm">
                  <div className="text-[13px] leading-[1.6] th-text-heading">
                    On it! Here&apos;s what I&apos;m setting up:
                  </div>
                  {[
                    { done: true, text: "Connected repo acme/store (Next.js detected)" },
                    { done: true, text: "Postgres 16 database provisioned" },
                    { done: true, text: "SSL wildcard cert issued for *.acme.com" },
                    { done: true, text: "Domain store.acme.com → project linked" },
                    { done: true, text: "Daily backup schedule enabled (03:00 UTC)" },
                    { done: true, text: "Security hardened — rate-limit, CORS, headers" },
                    { done: false, text: "Deploying to production…" },
                  ].map((step, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      {step.done ? (
                        <svg className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      ) : (
                        <div
                          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-t-transparent"
                          style={{ borderColor: "var(--th-clr-plum)", borderTopColor: "transparent" }}
                        />
                      )}
                      <span className={step.done ? "th-text-body" : "font-medium th-text-heading"}>
                        {step.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* Input bar */}
            <div className="border-t border-[var(--th-card-bd)] bg-[var(--th-sf-01)] px-5 py-3">
              <div className="flex items-center gap-3 rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] px-4 py-2.5">
                <span className="flex-1 text-[13px] th-text-muted">Ask AI to deploy, configure, debug…</span>
                <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "var(--th-btn-bg)", color: "var(--th-btn-text)" }}>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* AI Feature cards */}
          <div className="mx-auto mt-10 grid max-w-6xl gap-4 sm:grid-cols-2">
            {AI_FEATURES.map((f) => (
              <div
                key={f.title}
                className="group relative flex items-start gap-4 overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
              >
                {/* subtle blob */}
                <div
                  className="pointer-events-none absolute -right-10 -top-10 h-[140px] w-[140px] rounded-full blur-[50px]"
                  style={{ background: "var(--th-clr-plum-blob)" }}
                />
                <div
                  className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: "var(--th-clr-plum-bg)", color: "var(--th-clr-plum)" }}
                >
                  {f.icon}
                </div>
                <div className="relative">
                  <h4 className="text-[15px] font-semibold th-text-heading">{f.title}</h4>
                  <p className="mt-1.5 text-[13px] leading-[1.6] th-text-body">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Disable note */}
          <p className="mx-auto mt-6 max-w-lg text-center text-[13px] leading-[1.6] th-text-muted">
            AI is fully optional. Toggle it off in Settings &rarr; AI &amp; Automation.
            Every action it takes is visible and reversible.
          </p>
        </div>
      </div>
    </section>
  );
}
