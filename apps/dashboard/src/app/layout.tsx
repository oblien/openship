import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider, ThemeScript } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
import { I18nProvider } from "@/components/i18n-provider";

export const metadata: Metadata = {
  title: "Openship",
  description: "Manage your deployments, domains, and infrastructure.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>{children}</ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
