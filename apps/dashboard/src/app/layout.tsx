import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider, ThemeScript } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
import { I18nProvider } from "@/components/i18n-provider";
import { AuthProvider } from "@/context/AuthContext";
import { NetworkErrorHandler } from "@/components/network-error-handler";

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
          <AuthProvider>
            <I18nProvider>
              <ToastProvider>
                <NetworkErrorHandler />
                {children}
              </ToastProvider>
            </I18nProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
