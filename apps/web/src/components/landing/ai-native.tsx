export function AiNative() {
  return (
    <section className="relative py-28 sm:py-36">
      {/* Divider */}
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          {/* Left — text content */}
          <div>
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
              <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
                AI Native
              </span>
            </div>
            <h2>
              <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
                AI that handles
              </span>
              <span
                className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
                style={{ color: "var(--th-on-40)" }}
              >
                everything.
              </span>
            </h2>
            <p className="th-text-body mt-6 max-w-lg text-[16px] leading-[1.65]">
              When a build fails, the AI reads the error, identifies the root
              cause, and applies a fix — automatically. You see a green checkmark
              locally. Your server never sees the broken build.
            </p>

            <ul className="mt-8 space-y-4">
              {[
                "Monitors build logs and errors in real time",
                "Diagnoses dependency conflicts, type errors, and misconfigs",
                "Applies fixes automatically — you just approve in the UI",
                "Configures servers, databases, and SSL without you touching a terminal",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <svg
                    className="mt-0.5 h-5 w-5 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    style={{ color: 'var(--th-accent-indigo)' }}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75" />
                  </svg>
                  <span className="th-text-strong text-sm">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right — terminal visual */}
          <div className="terminal">
            <div className="terminal-bar">
              <div className="terminal-dot terminal-dot-red" />
              <div className="terminal-dot terminal-dot-yellow" />
              <div className="terminal-dot terminal-dot-green" />
              <span className="ml-3 text-xs" style={{ color: 'rgba(255,255,255,.3)' }}>
                Build Output
              </span>
            </div>
            <div className="terminal-body text-[13px]">
              {/* Build failure */}
              <div>
                <span className="t-muted">14:32:01</span>{" "}
                <span className="t-red">ERROR</span>{" "}
                Build failed with exit code 1
              </div>
              <div className="mt-1">
                <span className="t-muted">14:32:01</span>{" "}
                <span className="t-red">→</span>{" "}
                Module not found: &apos;@utils/helpers&apos;
              </div>
              <div className="mt-1">
                <span className="t-muted">14:32:01</span>{" "}
                <span className="t-muted">  at ./src/lib/api.ts:3:1</span>
              </div>

              {/* AI kicks in */}
              <div className="mt-4 border-t border-[rgba(255,255,255,.06)] pt-4">
                <span className="t-yellow">⚡ AI Agent</span>{" "}
                <span style={{ color: 'rgba(255,255,255,.5)' }}>analyzing build failure...</span>
              </div>
              <div className="mt-2">
                <span className="t-yellow">→</span>{" "}
                Path alias &quot;@utils&quot; not resolved. Found tsconfig paths
                mapping to &quot;src/utils&quot;.
              </div>
              <div className="mt-1">
                <span className="t-yellow">→</span>{" "}
                Updating import to relative path:{" "}
                <span className="t-green">&apos;../../utils/helpers&apos;</span>
              </div>
              <div className="mt-1">
                <span className="t-yellow">→</span>{" "}
                Adding path alias config to build:{" "}
                <span className="t-green">done</span>
              </div>

              {/* Retry */}
              <div className="mt-4 border-t border-[rgba(255,255,255,.06)] pt-4">
                <span className="t-muted">14:32:08</span>{" "}
                Retrying build with fix applied...
              </div>
              <div className="mt-1">
                <span className="t-muted">14:32:31</span>{" "}
                <span className="t-green">✓ Build succeeded</span>{" "}
                <span className="t-muted">(23s)</span>
              </div>
              <div className="mt-1">
                <span className="t-muted">14:32:32</span>{" "}
                <span className="t-green">✓ Deployed to production</span>
              </div>
            </div>
          </div>
        </div>

        {/* Trust / safety callout */}
        <div className="mt-16 grid gap-5 sm:grid-cols-3">
          {[
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} style={{ color: 'var(--th-accent-indigo)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              ),
              title: "Off by default",
              desc: "AI is completely disabled until you explicitly turn it on. No background calls, no hidden requests.",
            },
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} style={{ color: 'var(--th-accent-indigo)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ),
              title: "Human in the loop",
              desc: "Every proposed change needs your explicit approval. Nothing ships until you click confirm.",
            },
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} style={{ color: 'var(--th-accent-indigo)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              ),
              title: "Your model, your data",
              desc: "Use any provider — or a fully local model. Your code stays on your infrastructure, always.",
            },
          ].map((card) => (
            <div
              key={card.title}
              className="rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-5"
            >
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--th-sf-02)]">
                {card.icon}
              </div>
              <p className="text-[14px] font-semibold th-text-heading">{card.title}</p>
              <p className="mt-1.5 text-[13px] leading-[1.6] th-text-body">{card.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
