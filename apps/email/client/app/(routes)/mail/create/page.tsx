import { authProxy } from '@/lib/auth-proxy';
import type { Route } from './+types/page';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const baseUrl = import.meta.env.VITE_PUBLIC_APP_URL || new URL(request.url).origin;
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(`${baseUrl}/login`);

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries()) as {
    to?: string;
    subject?: string;
    body?: string;
  };
  const toParam = params.to || 'someone@someone.com';
  return Response.redirect(
    `${baseUrl}/mail/inbox?isComposeOpen=true&to=${encodeURIComponent(toParam)}${params.subject ? `&subject=${encodeURIComponent(params.subject)}` : ''}`,
  );
}

// export async function generateMetadata({ searchParams }: any) {
//   // Need to await searchParams in Next.js 15+
//   const params = await searchParams;

//   const toParam = params.to || 'someone';

//   // Create common metadata properties
//   const title = `Email ${toParam} on Zero`;
//   const description = 'Zero - The future of email is here';
//   const imageUrl = `/og-api/create?to=${encodeURIComponent(toParam)}${params.subject ? `&subject=${encodeURIComponent(params.subject)}` : ''}`;

//   // Create metadata object
//   return {
//     title,
//     description,
//     openGraph: {
//       title,
//       description,
//       images: [imageUrl],
//     },
//     twitter: {
//       card: 'summary_large_image',
//       title,
//       description,
//       images: [imageUrl],
//     },
//   };
// }
