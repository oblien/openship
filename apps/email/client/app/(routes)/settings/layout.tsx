import { SettingsLayoutContent } from '@/components/ui/settings-content';
import { Outlet } from 'react-router';
import { authProxy } from '@/lib/auth-proxy';
import type { Route } from './+types/layout';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const baseUrl = import.meta.env.VITE_PUBLIC_APP_URL || new URL(request.url).origin;
  const session = await authProxy.api.getSession({ headers: request.headers });

  if (!session) {
    return Response.redirect(`${baseUrl}/login`);
  }

  
  return null;
}

export default function SettingsLayout() {
  return (
    <SettingsLayoutContent>
      <Outlet />
    </SettingsLayoutContent>
  );
}