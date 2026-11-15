import { NotFoundContent } from "@/components/not-found-content";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/i18n/messages/en.json";
// apps/web has multiple root layouts (one per route group), so a global
// not-found renders WITHOUT any of them — it must supply its own document
// shell + styles, then compose the marketing chrome like the legal pages do.
import "./globals.css";

export default function NotFound() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Page not found — OpenShip</title>
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider locale="en" messages={{ Copy: messages.Copy }} timeZone="UTC">
          <NotFoundContent />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
