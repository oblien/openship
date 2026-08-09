import { useLoaderData, useNavigate } from 'react-router';

import { MailLayout } from '@/components/mail/mail';
import { useLabels } from '@/hooks/use-labels';
import { authProxy } from '@/lib/auth-proxy';
import { useEffect, useState } from 'react';
import type { Route } from './+types/page';

const ALLOWED_FOLDERS = new Set([
  'inbox',
  'draft',
  'sent',
  'spam',
  'bin',
  'archive',
  'snoozed',
  'starred',
  'important',
  'unread',
]);

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const baseUrl = import.meta.env.VITE_PUBLIC_APP_URL || new URL(request.url).origin;
  if (!params.folder) return Response.redirect(`${baseUrl}/mail/inbox`);

  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(`${baseUrl}/login`);

  return {
    folder: params.folder,
  };
}

export default function MailPage() {
  const { folder } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [isLabelValid, setIsLabelValid] = useState<boolean | null>(true);

  const isStandardFolder = ALLOWED_FOLDERS.has(folder);

  const { userLabels, isLoading: isLoadingLabels } = useLabels();

  useEffect(() => {
    if (isStandardFolder) {
      setIsLabelValid(true);
      return;
    }

    if (isLoadingLabels) return;

    if (userLabels) {
      const checkLabelExists = (labels: any[]): boolean => {
        for (const label of labels) {
          if (label.id === folder) return true;
          if (label.labels && label.labels.length > 0) {
            if (checkLabelExists(label.labels)) return true;
          }
        }
        return false;
      };

      const labelExists = checkLabelExists(userLabels);
      setIsLabelValid(labelExists);

      if (!labelExists) {
        const timer = setTimeout(() => {
          navigate('/mail/inbox');
        }, 2000);
        return () => clearTimeout(timer);
      }
    } else {
      setIsLabelValid(false);
    }
  }, [folder, userLabels, isLoadingLabels, isStandardFolder, navigate]);

  if (!isLabelValid) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">Folder not found</h2>
        <p className="text-muted-foreground mt-2">
          The folder you're looking for doesn't exist. Redirecting to inbox...
        </p>
      </div>
    );
  }

  return <MailLayout />;
}
