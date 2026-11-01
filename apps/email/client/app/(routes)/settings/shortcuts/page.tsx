import { SettingsCard } from '@/components/settings/settings-card';
import { formatDisplayKeys } from '@/lib/hotkeys/use-hotkey-utils';
import { useShortcutCache } from '@/lib/hotkeys/use-hotkey-utils';
import { useCategorySettings } from '@/hooks/use-categories';
import { type Shortcut } from '@/config/shortcuts';
import { m } from '@/paraglide/messages';
import { type ReactNode } from 'react';

type ShortcutMessage = Extract<keyof typeof m, `pages.settings.shortcuts.actions.${string}`>;

export default function ShortcutsPage() {
  const {
    shortcuts,
    // TODO: Implement shortcuts syncing and caching
    // updateShortcut,
  } = useShortcutCache();
  const categorySettings = useCategorySettings();

  return (
    <div className="grid gap-6">
      <SettingsCard
        title={m['pages.settings.shortcuts.title']()}
        description={m['pages.settings.shortcuts.description']()}
        // footer={
        //   <div className="flex gap-4">
        //     <Button
        //       variant="outline"
        //       onClick={async () => {
        //         try {
        //           await Promise.all(keyboardShortcuts.map((shortcut) => updateShortcut(shortcut)));
        //           toast.success('Shortcuts reset to defaults');
        //         } catch (error) {
        //           console.error('Failed to reset shortcuts:', error);
        //           toast.error('Failed to reset shortcuts');
        //         }
        //       }}
        //     >
        //       {t('common.actions.resetToDefaults')}
        //     </Button>
        //   </div>
        // }
      >
        <div className="grid max-w-3xl gap-6">
          {Object.entries(
            shortcuts.reduce<Record<string, Shortcut[]>>((acc, shortcut) => {
              const scope = shortcut.scope;
              if (!acc[scope]) acc[scope] = [];
              acc[scope].push(shortcut);
              return acc;
            }, {}),
          ).map(([scope, scopedShortcuts]) => (
            <div key={scope}>
              <h3 className="mb-4 text-lg font-semibold capitalize">
                {scope.split('-').join(' ')}
              </h3>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {scopedShortcuts.map((shortcut, index) => {
                  const categoryActionIndex: Record<string, number> = {
                    showImportant: 0,
                    showAllMail: 1,
                    showPersonal: 2,
                    showUpdates: 3,
                    showPromotions: 4,
                    showUnread: 5,
                  };

                  const message =
                    m[`pages.settings.shortcuts.actions.${shortcut.action}` as ShortcutMessage];
                  let label = message?.() ?? shortcut.action;

                  if (shortcut.action in categoryActionIndex && categorySettings.length) {
                    const idx = categoryActionIndex[shortcut.action];
                    const cat = categorySettings[idx];
                    if (cat) label = `Show ${cat.name}`;
                  }

                  return (
                    <ShortcutItem
                      key={`${scope}-${index}`}
                      keys={shortcut.keys}
                      //   action={shortcut.action}
                    >
                      {label}
                    </ShortcutItem>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

function ShortcutItem({ children, keys }: { children: ReactNode; keys: string[] }) {
  // const [isRecording, setIsRecording] = useState(false);
  const displayKeys = formatDisplayKeys(keys);

  // const { updateShortcut } = useShortcutCache(session?.user?.id);

  // const handleHotkeyRecorded = async (newKeys: string[]) => {
  //   try {
  //     // Find the original shortcut to preserve its type and description
  //     const originalShortcut = keyboardShortcuts.find((s) => s.action === action);
  //     if (!originalShortcut) {
  //       throw new Error('Original shortcut not found');
  //     }

  //     const updatedShortcut: Shortcut = {
  //       ...originalShortcut,
  //       keys: newKeys,
  //     };

  //     await updateShortcut(updatedShortcut);
  //     toast.success('Shortcut saved successfully');
  //   } catch (error) {
  //     console.error('Failed to save shortcut:', error);
  //     toast.error('Failed to save shortcut');
  //   }
  // };

  return (
    <>
      <div
        className="bg-popover text-muted-foreground hover:bg-accent/50 flex cursor-pointer items-center justify-between gap-2 rounded-lg border p-2 text-sm"
        // onClick={() => setIsRecording(true)}
        role="button"
        tabIndex={0}
      >
        <span className="font-medium">{children}</span>
        <div className="flex select-none gap-1">
          {displayKeys.map((key) => (
            <kbd
              key={key}
              className="border-muted-foreground/10 bg-accent h-6 rounded-[6px] border px-1.5 font-mono text-xs leading-6"
            >
              {key}
            </kbd>
          ))}
        </div>
      </div>
      {/* <HotkeyRecorder
        isOpen={isRecording}
        onClose={() => setIsRecording(false)}
        onHotkeyRecorded={handleHotkeyRecorded}
        currentKeys={keys}
      /> */}
    </>
  );
}
