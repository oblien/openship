import { useKeyboardLayout } from '@/components/keyboard-layout-indicator';
import { LoadingProvider } from '@/components/context/loading-context';
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useSettings } from '@/hooks/use-settings';
import { Provider as JotaiProvider } from 'jotai';
import type { PropsWithChildren } from 'react';
import Toaster from '@/components/ui/toast';
import { ThemeProvider, useTheme } from 'next-themes';

function MailThemeColor() {
  const { resolvedTheme } = useTheme();
  const light = '#fafafa';
  const dark = '#111112';
  if (resolvedTheme === 'dark' || resolvedTheme === 'light')
    return <meta name="theme-color" content={resolvedTheme === 'dark' ? dark : light} />;
  return (
    <>
      <meta name="theme-color" content={dark} media="(prefers-color-scheme: dark)" />
      <meta name="theme-color" content={light} media="(prefers-color-scheme: light)" />
    </>
  );
}

export function ClientProviders({ children }: PropsWithChildren) {
  const { data } = useSettings();
  useKeyboardLayout();

  const theme = data?.settings.colorTheme || 'system';

  return (
    <NuqsAdapter>
      <JotaiProvider>
        <ThemeProvider
          attribute="class"
          enableSystem
          disableTransitionOnChange
          defaultTheme={theme}
        >
          <MailThemeColor />
          <SidebarProvider>
            <LoadingProvider>
              {children}
              <Toaster />
            </LoadingProvider>
          </SidebarProvider>
        </ThemeProvider>
      </JotaiProvider>
    </NuqsAdapter>
  );
}
