import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider, ThemeScript } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
import { ToastProvider as ContextToastProvider } from "@/context/ToastContext";
import { I18nProvider } from "@/components/i18n-provider";
import { AuthProvider } from "@/context/AuthContext";
import { NetworkErrorHandler } from "@/components/network-error-handler";

export const metadata: Metadata = {
  title: "Openship",
  description: "Manage your deployments, domains, and infrastructure.",
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    other: [
      { url: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
  manifest: '/site.webmanifest',
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
                <ContextToastProvider>
                <NetworkErrorHandler />
                {children}
                </ContextToastProvider>
              </ToastProvider>
            </I18nProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
