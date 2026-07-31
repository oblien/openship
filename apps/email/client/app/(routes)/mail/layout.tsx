import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { AppSidebar } from '@/components/ui/app-sidebar';
import { Outlet } from 'react-router';

export default function MailLayout() {
  return (
    <HotkeyProviderWrapper>
      <AppSidebar />
      <main className="bg-sidebar dark:bg-sidebar w-full">
        <Outlet />
      </main>
    </HotkeyProviderWrapper>
  );
}
