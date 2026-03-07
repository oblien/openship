import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/session";

/**
 * Auth layout — minimal shell, no sidebar.
 * If the user already has a valid session, redirect to dashboard.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session) redirect("/");

  return <div className="th-page">{children}</div>;
}
