/**
 * Dashboard shell layout — sidebar + top bar wrapper.
 * All authenticated dashboard pages live under this layout.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r bg-gray-50 p-4">
        <div className="mb-8 text-lg font-bold">Openship</div>
        <nav className="flex flex-col gap-1 text-sm">
          <a href="/projects" className="rounded px-3 py-2 hover:bg-gray-200">
            Projects
          </a>
          <a href="/deployments" className="rounded px-3 py-2 hover:bg-gray-200">
            Deployments
          </a>
          <a href="/domains" className="rounded px-3 py-2 hover:bg-gray-200">
            Domains
          </a>
          <a href="/monitoring" className="rounded px-3 py-2 hover:bg-gray-200">
            Monitoring
          </a>
          <a href="/settings" className="rounded px-3 py-2 hover:bg-gray-200">
            Settings
          </a>
          <a href="/billing" className="rounded px-3 py-2 hover:bg-gray-200">
            Billing
          </a>
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
