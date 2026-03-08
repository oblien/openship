import type { ReactNode } from "react";
import Link from "next/link";
import "./blog.css";

export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <header className="sticky top-0 z-50 border-b border-gray-100 bg-white/80 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3.5">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-50"
          >
            <span
              className="inline-block h-[24px] w-[24px] shrink-0 rounded-full"
              style={{ border: "2.5px solid currentColor" }}
            />
            Openship
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="/docs"
              className="text-[14px] text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            >
              Docs
            </Link>
            <Link
              href="/blog"
              className="text-[14px] font-medium text-gray-900 dark:text-gray-50"
            >
              Blog
            </Link>
            <a
              href="https://github.com/openshiporg/openship"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              aria-label="GitHub"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
