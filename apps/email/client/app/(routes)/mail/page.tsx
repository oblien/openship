export function clientLoader({ request }: { request?: Request } = {}) {
  const baseUrl = import.meta.env.VITE_PUBLIC_APP_URL || (request ? new URL(request.url).origin : '');
  return Response.redirect(`${baseUrl}/mail/inbox`);
}
