import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/session";
import { Sidebar } from "@/components/sidebar";

/**
 * Dashboard shell layout — sidebar + main area.
 * Session is validated server-side before rendering.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex h-dvh bg-background">
      <Sidebar user={session.user} />

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
