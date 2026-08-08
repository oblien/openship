import { absoluteAppUrl } from '@/lib/app-url';

export function clientLoader() {
  return Response.redirect(absoluteAppUrl('/mail/inbox'));
}
