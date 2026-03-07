export function AiNative() {
  return (
    <section className="relative py-28 sm:py-36">
      {/* Divider */}
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          {/* Left — text content */}
          <div>
            <p className="th-text-muted mb-3 text-sm font-semibold uppercase tracking-widest">
              AI Native
            </p>
            <h2 className="th-text-heading text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              AI that fixes
              <br />
              your builds
            </h2>
            <p className="th-text-body mt-6 max-w-lg text-lg leading-relaxed">
              When a build fails, the built-in AI agent reads the error logs,
              identifies the root cause, and applies a fix — automatically.
              No more staring at stack traces.
            </p>

            <ul className="mt-8 space-y-4">
              {[
                "Reads build logs and error output in real time",
                "Diagnoses dependency conflicts, type errors, and misconfigurations",
                "Suggests or auto-applies fixes and retriggers the build",
                "Works with any framework — zero configuration needed",
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
      </div>
    </section>
  );
}
