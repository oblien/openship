import { getAppUrl } from '@/lib/backend-url';

export function clientLoader() {
  return Response.redirect(`${getAppUrl()}/mail/inbox`);
}
