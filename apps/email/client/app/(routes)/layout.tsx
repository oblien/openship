import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { CommandPaletteProvider } from '@/components/context/command-palette-context';

import { Outlet } from 'react-router';
import { AISidebarProvider } from '@/components/ui/ai-sidebar';

export default function Layout() {
  return (
    <CommandPaletteProvider>
      <HotkeyProviderWrapper>
        <div className="bg-sidebar relative flex max-h-screen w-full overflow-hidden">
          <AISidebarProvider>
            <Outlet />
          </AISidebarProvider>
        </div>
      </HotkeyProviderWrapper>
    </CommandPaletteProvider>
  );
}
