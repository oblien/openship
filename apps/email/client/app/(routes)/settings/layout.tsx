import { SettingsLayoutContent } from '@/components/ui/settings-content';
import { Outlet } from 'react-router';
import { authProxy } from '@/lib/auth-proxy';
import { getAppUrl } from '@/lib/backend-url';
import type { Route } from './+types/layout';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await authProxy.api.getSession({ headers: request.headers });

  if (!session) {
    return Response.redirect(`${getAppUrl()}/login`);
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