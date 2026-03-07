/**
 * Marketing layout — wraps docs, pricing, and other marketing sub-routes.
 * The landing page (/) has its own Navbar/Footer built-in, so this layout
 * provides a shared wrapper for secondary marketing pages only.
 */

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
