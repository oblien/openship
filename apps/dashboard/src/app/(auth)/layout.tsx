/**
 * Auth layout — minimal shell without sidebar, used for login/register pages.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gray-50">{children}</div>;
}
