export function DeveloperExperience() {
  return (
    <section className="relative py-28 sm:py-36">
      {/* Divider */}
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Section header */}
        <div className="mx-auto max-w-2xl text-center">
          <p className="th-text-muted mb-3 text-sm font-semibold uppercase tracking-widest">
            Developer Experience
          </p>
          <h2 className="th-text-heading text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Built for developers
          </h2>
          <p className="th-text-body mt-5 text-lg leading-relaxed">
            CLI, MCP, and API — every workflow, every tool, every agent. First-class support.
          </p>
        </div>

        {/* Three columns */}
        <div className="mx-auto mt-16 grid max-w-5xl gap-6 lg:grid-cols-3">
          {/* ── CLI ───────────────────────────────────────────── */}
          <div className="th-card flex flex-col overflow-hidden">
            <div className="p-6 pb-0">
              <div className="feature-icon mb-3">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              <h3 className="th-text-title text-base font-semibold">CLI</h3>
              <p className="th-text-body mt-1.5 text-sm leading-relaxed">
                Deploy, rollback, stream logs, and manage projects — from your terminal.
              </p>
            </div>
            <div className="mt-4 flex-1">
              <div className="terminal rounded-none border-t border-[rgba(255,255,255,.04)]" style={{ borderRadius: '0 0 1rem 1rem', boxShadow: 'none' }}>
                <div className="terminal-body !py-4 text-[12.5px]">
                  <div><span className="t-muted">$</span> <span className="t-blue">openship</span> deploy</div>
                  <div><span className="t-muted">$</span> <span className="t-blue">openship</span> logs --follow</div>
                  <div><span className="t-muted">$</span> <span className="t-blue">openship</span> rollback v3</div>
                  <div><span className="t-muted">$</span> <span className="t-blue">openship</span> domains add *.app.com</div>
                </div>
              </div>
            </div>
          </div>

          {/* ── MCP ──────────────────────────────────────────── */}
          <div className="th-card flex flex-col overflow-hidden">
            <div className="p-6 pb-0">
              <div className="feature-icon mb-3">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
              </div>
              <h3 className="th-text-title text-base font-semibold">MCP Support</h3>
              <p className="th-text-body mt-1.5 text-sm leading-relaxed">
                Agent-friendly via Model Context Protocol. AI assistants can deploy and manage for you.
              </p>
            </div>
            <div className="mt-4 flex-1">
              <div className="terminal rounded-none border-t border-[rgba(255,255,255,.04)]" style={{ borderRadius: '0 0 1rem 1rem', boxShadow: 'none' }}>
                <div className="terminal-body !py-4 text-[12.5px]">
                  <div><span className="t-muted">{"//"}</span> AI Agent via MCP</div>
                  <div className="mt-1"><span className="t-yellow">agent</span>: deploy my-app to production</div>
                  <div className="mt-1"><span className="t-green">openship</span>: Building... <span className="t-green">✓</span></div>
                  <div><span className="t-green">openship</span>: SSL provisioned <span className="t-green">✓</span></div>
                  <div><span className="t-green">openship</span>: Live at app.com <span className="t-green">✓</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* ── API ──────────────────────────────────────────── */}
          <div className="th-card flex flex-col overflow-hidden">
            <div className="p-6 pb-0">
              <div className="feature-icon mb-3">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                </svg>
              </div>
              <h3 className="th-text-title text-base font-semibold">REST API</h3>
              <p className="th-text-body mt-1.5 text-sm leading-relaxed">
                Full API access. Build custom integrations, CI/CD pipelines, and automation workflows.
              </p>
            </div>
            <div className="mt-4 flex-1">
              <div className="terminal rounded-none border-t border-[rgba(255,255,255,.04)]" style={{ borderRadius: '0 0 1rem 1rem', boxShadow: 'none' }}>
                <div className="terminal-body !py-4 text-[12.5px]">
                  <div><span className="t-blue">POST</span> /api/v1/deployments</div>
                  <div><span className="t-blue">GET</span>  /api/v1/projects</div>
                  <div><span className="t-blue">POST</span> /api/v1/domains</div>
                  <div><span className="t-blue">GET</span>  /api/v1/logs/:id</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
