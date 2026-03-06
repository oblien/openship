/**
 * Auth layout — minimal shell, no sidebar.
 * Background and body color come from theme tokens.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="th-page">{children}</div>;
}
