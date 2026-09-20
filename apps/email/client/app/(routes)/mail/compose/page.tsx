import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CreateEmail } from '@/components/create/create-email';
import { authProxy } from '@/lib/auth-proxy';
import { useLoaderData, replace } from 'react-router';
import type { Route } from './+types/page';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) throw replace('/login');
  const url = new URL(request.url);
  if (url.searchParams.get('to')?.startsWith('mailto:')) {
    // `/api/mailto-handler` is where routes.ts mounts mailto-handler.ts. The
    // old target, `/mail/compose/handle-mailto`, matches no route at all - it
    // fell through to the splat 404.
    const mailto = new URLSearchParams({ mailto: url.searchParams.get('to') ?? '' });
    throw replace(`/api/mailto-handler?${mailto}`);
  }

  return Object.fromEntries(url.searchParams.entries()) as {
    to?: string;
    subject?: string;
    body?: string;
    draftId?: string;
    cc?: string;
    bcc?: string;
  };
}

export default function ComposePage() {
  const params = useLoaderData<typeof clientLoader>();

  return (
    <Dialog open={true}>
      <DialogTitle></DialogTitle>
      <DialogDescription></DialogDescription>
      <DialogTrigger></DialogTrigger>
      <DialogContent className="h-screen w-screen max-w-none border-none bg-[#FAFAFA] p-0 shadow-none dark:bg-[#141414]">
        <CreateEmail
          initialTo={params.to || ''}
          initialSubject={params.subject || ''}
          initialBody={params.body || ''}
          initialCc={params.cc || ''}
          initialBcc={params.bcc || ''}
          draftId={params.draftId || null}
        />
      </DialogContent>
    </Dialog>
  );
}
