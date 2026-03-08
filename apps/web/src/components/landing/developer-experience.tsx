const TOOLS = [
  {
    tag: "CLI",
    title: "Deploy from your terminal",
    desc: "Full control without leaving the command line. Deploy, rollback, stream live logs, and manage domains — all with a single binary.",
    icon: (
      <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
    chips: ["deploy", "logs --follow", "rollback", "domains"],
    chipPrefix: "openship ",
    blob: "var(--th-clr-plum-blob)",
    code: [
      { kind: "muted", text: "$" },
      { text: " openship deploy " },
      { kind: "muted", text: "--prod" },
      { br: true },
      { kind: "muted", text: "›" },
      { text: " Detecting framework… " },
      { kind: "ok", text: "Next.js" },
      { br: true },
      { kind: "muted", text: "›" },
      { text: " Building… " },
      { kind: "muted", text: "34s" },
      { br: true },
      { kind: "ok", text: "✓" },
      { text: " Deployed to " },
      { kind: "accent", text: "prod" },
    ],
  },
  {
    tag: "MCP",
    title: "Let your AI agent deploy",
    desc: "Native Model Context Protocol support. Give Cursor, Claude, or any AI assistant the ability to deploy, rollback, and monitor — without leaving the chat.",
    icon: (
      <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
    chips: ["deploy", "rollback", "logs", "status"],
    chipPrefix: "mcp/",
    blob: "var(--th-clr-terra-blob)",
    code: [
      { kind: "muted", text: "// Cursor — MCP tool call" },
      { br: true },
      { kind: "accent", text: "you" },
      { kind: "muted", text: ": " },
      { text: "deploy my-app to production" },
      { br: true },
      { kind: "accent", text: "cursor" },
      { kind: "muted", text: ": calling " },
      { kind: "ok", text: "openship/deploy" },
      { text: "…" },
      { br: true },
      { kind: "ok", text: "✓" },
      { text: " Live at " },
      { kind: "accent", text: "my-app.example.com" },
    ],
  },
  {
    tag: "REST API",
    title: "Automate everything",
    desc: "A complete REST API for every action in the platform. Build CI/CD pipelines, custom dashboards, or integrate deployments directly into your own product.",
    icon: (
      <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
      </svg>
    ),
    chips: ["/deployments", "/projects", "/domains", "/logs"],
    chipPrefix: "",
    blob: "var(--th-clr-sea-blob)",
    code: [
      { kind: "accent", text: "POST" },
      { text: " /api/v1/deployments" },
      { br: true },
      { kind: "muted", text: "Authorization: Bearer ••••••" },
      { br: true },
      { kind: "muted", text: "{ " },
      { kind: "accent", text: '"project"' },
      { kind: "muted", text: ": " },
      { kind: "ok", text: '"my-app"' },
      { kind: "muted", text: " }" },
      { br: true },
      { kind: "ok", text: "201" },
      { kind: "muted", text: ' { id: "dep_01J…" }' },
    ],
  },
];

const C = {
  ok: "var(--th-clr-sea)",
  accent: "var(--th-on-70, rgba(45,52,54,.70))",
  muted: "var(--th-on-25, rgba(45,52,54,.25))",
  dot: "var(--th-on-10, rgba(45,52,54,.10))",
  bg: "var(--th-on-04, rgba(45,52,54,.04))",
  bd: "var(--th-on-06, rgba(45,52,54,.06))",
};

function CodeLine({ tokens }: { tokens: typeof TOOLS[number]["code"] }) {
  return (
    <div className="font-mono text-[13px] leading-[1.7]">
      {tokens.map((t, i) =>
        "br" in t ? (
          <br key={i} />
        ) : (
          <span
            key={i}
            style={{
              color:
                t.kind === "ok"
                  ? C.ok
                  : t.kind === "accent"
                  ? C.accent
                  : t.kind === "muted"
                  ? C.muted
                  : "rgba(45,52,54,.55)",
            }}
          >
            {t.text}
          </span>
        )
      )}
    </div>
  );
}

export function DeveloperExperience() {
  return (
    <section className="relative py-28 sm:py-36">
      {/* Divider */}
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="grid gap-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
              <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
                Developer Experience
              </span>
            </div>
            <h2>
              <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
                App first.
              </span>
              <span
                className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
                style={{ color: "var(--th-on-40)" }}
              >
                CLI when you want it.
              </span>
            </h2>
          </div>
          <p className="max-w-[340px] text-[16px] leading-[1.65] th-text-body lg:mb-1">
            The app handles everything visually. CLI, MCP, and REST API
            are there for developers who want deeper control.
          </p>
        </div>

        {/* Cards */}
        <div className="mt-16 grid gap-4 lg:grid-cols-3">
          {TOOLS.map((t) => (
            <div
              key={t.tag}
              className="relative flex flex-col overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[var(--th-card-shadow)] transition-[border-color,box-shadow] duration-200 hover:border-[var(--th-card-bd-hover)] hover:shadow-[0_4px_12px_rgba(0,0,0,.06)]"
            >
              {/* Ambient blob */}
              <div
                className="pointer-events-none absolute -top-12 -right-12 h-[180px] w-[180px] rounded-full blur-[60px]"
                style={{ background: t.blob }}
                aria-hidden="true"
              />
              {/* Top: text */}
              <div className="relative flex flex-col gap-4 p-7 pb-5">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--th-card-bd)] th-text-secondary">
                    {t.icon}
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] th-text-muted">
                    {t.tag}
                  </span>
                </div>
                <h3 className="text-[20px] font-semibold tracking-[-0.02em] th-text-heading">
                  {t.title}
                </h3>
                <p className="text-[14px] leading-[1.65] th-text-body">
                  {t.desc}
                </p>
                <div className="flex flex-wrap gap-2">
                  {t.chips.map((c) => (
                    <code
                      key={c}
                      className="rounded-md border border-[var(--th-card-bd)] bg-[var(--th-bg-subtle,rgba(0,0,0,.03))] px-2.5 py-1 text-[12px] font-mono th-text-secondary"
                    >
                      {t.chipPrefix}{c}
                    </code>
                  ))}
                </div>
              </div>

              {/* Bottom: light code block */}
              <div className="mt-auto border-t border-[var(--th-card-bd)]">
                {/* Dot bar */}
                <div className="flex items-center gap-1.5 px-5 pt-3.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-[7px] w-[7px] rounded-full"
                      style={{ background: C.dot }}
                    />
                  ))}
                </div>
                <div className="px-5 py-4">
                  <CodeLine tokens={t.code} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}