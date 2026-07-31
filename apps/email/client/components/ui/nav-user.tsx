import {
  HelpCircle,
  LogOut,
  MoonIcon,
  Settings,
  Plus,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActiveConnection, useConnections } from '@/hooks/use-connections';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLoading } from '../context/loading-context';
import { signOut, useSession } from '@/lib/auth-client';
import { AddConnectionDialog } from '../connection/add';
import { CircleCheck, ThreeDots } from '../icons/icons';
import { useTRPC } from '@/providers/query-provider';
import { useSidebar } from '@/components/ui/sidebar';
import { SunIcon } from '../icons/animated/sun';
import { useLocation } from 'react-router';
import { m } from '@/paraglide/messages';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function NavUser() {
  const { data: session } = useSession();
  const { data } = useConnections();
  const [isRendered, setIsRendered] = useState(false);
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { state } = useSidebar();
  const trpc = useTRPC();
  const [, setThreadId] = useQueryState('threadId');
  const { mutateAsync: setDefaultConnection } = useMutation(
    trpc.connections.setDefault.mutationOptions(),
  );
  const pathname = useLocation().pathname;
  const { data: activeConnection, refetch: refetchActiveConnection } = useActiveConnection();
  const [category] = useQueryState('category', { defaultValue: 'All Mail' });
  const { setLoading } = useLoading();

  const getSettingsHref = useCallback(() => {
    const currentPath = category
      ? `${pathname}?category=${encodeURIComponent(category)}`
      : pathname;
    return `/settings/general?from=${encodeURIComponent(currentPath)}`;
  }, [pathname, category]);

  const { data: activeAccount } = useActiveConnection();

  useEffect(() => setIsRendered(true), []);

  const handleAccountSwitch = (connectionId: string) => async () => {
    if (connectionId === activeConnection?.id) return;

    try {
      setLoading(true, m['common.navUser.switchingAccounts']());
      setThreadId(null);
      await setDefaultConnection({ connectionId });
      // Hard navigate so root.tsx re-reads the active-session companion
      // cookie and remounts QueryProvider with the new connection's IDB
      // slot. The previous user's persisted cache stays untouched under
      // its own slot - switching back is instant.
      window.location.href = '/mail/inbox';
    } catch (error) {
      console.error('Error switching accounts:', error);
      toast.error(m['common.navUser.failedToSwitchAccount']());

      await refetchActiveConnection();
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    toast.promise(signOut(), {
      loading: 'Signing out...',
      success: () => 'Signed out successfully!',
      error: 'Error signing out',
      async finally() {
        // signOut() drops only the current connection's IDB slot. The
        // server falls the active cookie back to the next signed-in
        // mailbox if any; we always hard-navigate to /mail/inbox and let
        // the route guard send the user to /login if the fallthrough
        // session also ended up cleared.
        window.location.href = '/mail/inbox';
      },
    });
  };

  const otherConnections = useMemo(() => {
    if (!data || !activeAccount) return [];
    return data.connections.filter((connection) => connection.id !== activeAccount?.id);
  }, [data, activeAccount]);

  const handleThemeToggle = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  if (!isRendered) return null;
  if (!session) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {state === 'collapsed' ? (
          activeAccount && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <div className="flex cursor-pointer items-center">
                  <div className="relative">
                    <Avatar className="relative left-0.5 size-7 rounded-[5px]">
                      <AvatarImage
                        className="rounded-[5px]"
                        src={activeAccount?.picture || undefined}
                        alt={activeAccount?.name || activeAccount?.email}
                      />

                      <AvatarFallback className="rounded-[5px] text-[10px]">
                        {(activeAccount?.name || activeAccount?.email || '')
                          .split(' ')
                          .map((n: string) => n[0])
                          .join('')
                          .toUpperCase()
                          .slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) ml-3 min-w-56 bg-white font-medium dark:bg-[#131313]"
                align="end"
                side={'bottom'}
                sideOffset={8}
              >
                {session && activeAccount && (
                  <>
                    <div className="flex flex-col items-center p-3 text-center">
                      <Avatar className="border-border/50 mb-2 size-14 rounded-xl border">
                        <AvatarImage
                          className="rounded-xl"
                          src={
                            (activeAccount.picture ?? undefined) ||
                            (session.user.image ?? undefined)
                          }
                          alt={activeAccount.name || session.user.name || 'User'}
                        />
                        <AvatarFallback className="rounded-xl">
                          <span>
                            {(activeAccount.name || session.user.name || 'User')
                              .split(' ')
                              .map((n) => n[0])
                              .join('')
                              .toUpperCase()
                              .slice(0, 2)}
                          </span>
                        </AvatarFallback>
                      </Avatar>
                      <div className="w-full">
                        <div className="flex items-center justify-center gap-0.5 text-sm font-medium">
                          {activeAccount.name || session.user.name || 'User'}
                        </div>
                        <div className="text-muted-foreground text-xs">{activeAccount.email}</div>
                      </div>
                    </div>
                    <DropdownMenuSeparator />
                  </>
                )}
                <div className="space-y-1">
                  <>
                    <p className="text-muted-foreground px-2 py-1 text-[11px] font-medium">
                      {m['common.navUser.accounts']()}
                    </p>

                    {data?.connections
                      ?.filter((connection) => connection.id !== activeConnection?.id)
                      .map((connection) => (
                        <DropdownMenuItem
                          key={connection.id}
                          onClick={handleAccountSwitch(connection.id)}
                          className="flex cursor-pointer items-center gap-3 py-1"
                        >
                          <Avatar className="size-7 rounded-lg">
                            <AvatarImage
                              className="rounded-lg"
                              src={connection.picture || undefined}
                              alt={connection.name || connection.email}
                            />
                            <AvatarFallback className="rounded-lg text-[10px]">
                              {(connection.name || connection.email)
                                .split(' ')
                                .map((n) => n[0])
                                .join('')
                                .toUpperCase()
                                .slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="-space-y-0.5">
                            <p className="text-[12px]">{connection.name || connection.email}</p>
                            {connection.name && (
                              <p className="text-muted-foreground text-[11px]">
                                {connection.email.length > 25
                                  ? `${connection.email.slice(0, 25)}...`
                                  : connection.email}
                              </p>
                            )}
                          </div>
                        </DropdownMenuItem>
                      ))}
                    <AddConnectionDialog />

                    <DropdownMenuSeparator className="my-1" />

                    <DropdownMenuItem asChild>
                      <a href={getSettingsHref()} className="cursor-pointer">
                        <div className="flex items-center gap-2">
                          <Settings size={16} className="opacity-60" />
                          <p className="text-[13px] opacity-60">{m['common.actions.settings']()}</p>
                        </div>
                      </a>
                    </DropdownMenuItem>
                  </>
                </div>
                <>
                  <DropdownMenuSeparator className="mt-1" />
                  <DropdownMenuItem onSelect={() => handleThemeToggle()} className="cursor-pointer">
                    <div className="flex w-full items-center gap-2">
                    {resolvedTheme === 'dark' ? (
                        <MoonIcon className="size-4 opacity-60" />
                      ) : (
                        <SunIcon className="size-4 opacity-60" />
                      )}
                      <p className="text-[13px] opacity-60">{m['common.navUser.appTheme']()}</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onSelect={() => handleLogout()}>
                    <div className="flex items-center gap-2">
                      <LogOut size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">{m['common.actions.logout']()}</p>
                    </div>
                  </DropdownMenuItem>
                </>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              {data && activeAccount ? (
                <div
                  key={activeAccount.id}
                  onClick={handleAccountSwitch(activeAccount.id)}
                  className={`flex cursor-pointer items-center ${
                    activeAccount.id === activeConnection?.id && data.connections.length > 1
                      ? 'outline-mainBlue rounded-[5px] outline outline-2'
                      : ''
                  }`}
                >
                  <div className="relative">
                    <Avatar className="size-7 rounded-[5px]">
                      <AvatarImage
                        className="rounded-[5px]"
                        src={activeAccount.picture || undefined}
                        alt={activeAccount.name || activeAccount.email}
                      />
                      <AvatarFallback className="rounded-[5px] text-[10px]">
                        {(activeAccount.name || activeAccount.email)
                          .split(' ')
                          .map((n) => n[0])
                          .join('')
                          .toUpperCase()
                          .slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    {activeAccount.id === activeConnection?.id && data.connections.length > 1 && (
                      <CircleCheck className="fill-mainBlue absolute -bottom-2 -right-2 size-4 rounded-full bg-white dark:bg-[#141414]" />
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex cursor-pointer items-center">
                  <div className="relative">
                    <div className="bg-muted size-6 animate-pulse rounded-[5px]" />
                  </div>
                </div>
              )}
              {otherConnections.slice(0, 2).map((connection) => (
                <Tooltip key={connection.id}>
                  <TooltipTrigger asChild>
                    <div
                      onClick={handleAccountSwitch(connection.id)}
                      className={`flex cursor-pointer items-center ${
                        connection.id === activeConnection?.id && otherConnections.length > 1
                          ? 'outline-mainBlue rounded-[5px] outline outline-2'
                          : ''
                      }`}
                    >
                      <div className="relative">
                        <Avatar className="size-7 rounded-[5px]">
                          <AvatarImage
                            className="rounded-[5px]"
                            src={connection.picture || undefined}
                            alt={connection.name || connection.email}
                          />
                          <AvatarFallback className="rounded-[5px] text-[10px]">
                            {(connection.name || connection.email)
                              .split(' ')
                              .map((n) => n[0])
                              .join('')
                              .toUpperCase()
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        {connection.id === activeConnection?.id && otherConnections.length > 1 && (
                          <CircleCheck className="fill-mainBlue absolute -bottom-2 -right-2 size-4 rounded-full bg-white dark:bg-black" />
                        )}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-muted-foreground text-xs">
                    {connection.email}
                  </TooltipContent>
                </Tooltip>
              ))}

              {otherConnections.length > 3 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="hover:bg-muted flex h-7 w-7 cursor-pointer items-center justify-center rounded-[5px]">
                      <span className="text-[10px]">+{otherConnections.length - 3}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="ml-3 min-w-56 bg-white font-medium dark:bg-[#131313]"
                    align="end"
                    side={'bottom'}
                    sideOffset={8}
                  >
                    {otherConnections.slice(3).map((connection) => (
                      <DropdownMenuItem
                        key={connection.id}
                        onClick={handleAccountSwitch(connection.id)}
                        className="flex cursor-pointer items-center gap-3 py-1"
                      >
                        <Avatar className="size-7 rounded-lg">
                          <AvatarImage
                            className="rounded-lg"
                            src={connection.picture || undefined}
                            alt={connection.name || connection.email}
                          />
                          <AvatarFallback className="rounded-lg text-[10px]">
                            {(connection.name || connection.email)
                              .split(' ')
                              .map((n) => n[0])
                              .join('')
                              .toUpperCase()
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="-space-y-0.5">
                          <p className="text-[12px]">{connection.name || connection.email}</p>
                          {connection.name && (
                            <p className="text-muted-foreground text-[11px]">
                              {connection.email.length > 25
                                ? `${connection.email.slice(0, 25)}...`
                                : connection.email}
                            </p>
                          )}
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <AddConnectionDialog>
                <Button className="hover:bg-offsetLight/80 dark:hover:bg-offsetDark/80 flex h-7 w-7 cursor-pointer items-center justify-center rounded-[5px] border border-dashed bg-transparent px-0 text-black dark:bg-[#262626] dark:text-[#929292]">
                  <Plus className="size-4" />
                </Button>
              </AddConnectionDialog>
            </div>

            <div className="flex items-center justify-center gap-1">
              {/* {isSessionPending ? null : !session.user.phoneNumberVerified ? (
                <SetupInboxDialog />
              ) : (
                <CallInboxDialog />
              )} */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className={cn('md:h-fit md:px-2')}>
                    <ThreeDots className="fill-iconLight dark:fill-iconDark" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="ml-3 min-w-56 bg-white font-medium dark:bg-[#131313]"
                  align="end"
                  side={'bottom'}
                  sideOffset={8}
                >
                  <DropdownMenuItem asChild>
                    <a href={getSettingsHref()} className="cursor-pointer">
                      <div className="flex items-center gap-2">
                        <Settings size={16} className="opacity-60" />
                        <p className="text-[13px] opacity-60">{m['common.actions.settings']()}</p>
                      </div>
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mt-1" />
                  <DropdownMenuItem onClick={handleThemeToggle} className="cursor-pointer">
                    <div className="flex w-full items-center gap-2">
                      {theme === 'dark' ? (
                        <MoonIcon className="size-4 opacity-60" />
                      ) : (
                        <SunIcon className="size-4 opacity-60" />
                      )}
                      <p className="text-[13px] opacity-60">{m['common.navUser.appTheme']()}</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onClick={handleLogout}>
                    <div className="flex items-center gap-2">
                      <LogOut size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">{m['common.actions.logout']()}</p>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </div>

      {state !== 'collapsed' &&
        (() => {
          const accountEmail = activeAccount?.email || session.user.email;
          const displayName = activeAccount?.name || session.user.name;
          // A mailbox with no display name set falls back to the email for
          // BOTH the name line and the email line below it - same string
          // twice, one truncated harder than the other. Show just the one
          // line when there's nothing besides the email to show.
          const hasDistinctName =
            !!displayName && displayName.trim().toLowerCase() !== accountEmail?.trim().toLowerCase();
          return (
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="mt-[2px] flex flex-col items-start gap-1 space-y-1">
                {hasDistinctName && (
                  <div className="flex items-center gap-1 text-[13px] leading-none text-black dark:text-white">
                    <p className={cn('max-w-[14.5ch] truncate text-[13px]')} title={displayName}>
                      {displayName}
                    </p>
                  </div>
                )}
                <div
                  className="h-5 max-w-[200px] overflow-hidden truncate text-xs font-normal leading-none text-[#898989]"
                  title={accountEmail}
                >
                  {accountEmail}
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
