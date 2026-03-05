export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      {/* Marketing nav / header goes here */}
      <header className="border-b px-6 py-4">
        <nav className="mx-auto flex max-w-7xl items-center justify-between">
          <span className="text-xl font-bold">Openship</span>
          <div className="flex items-center gap-6">
            <a href="/pricing" className="text-sm hover:underline">
              Pricing
            </a>
            <a href="/docs" className="text-sm hover:underline">
              Docs
            </a>
            <a href="/login" className="text-sm font-medium hover:underline">
              Login
            </a>
          </div>
        </nav>
      </header>
      {children}
    </div>
  );
}
