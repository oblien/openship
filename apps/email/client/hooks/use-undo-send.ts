import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/providers/query-provider';
import { undoStorageKey } from '@/lib/undo-storage';
import { isSendResult } from '@/lib/email-utils';
import { serializeFiles } from '@/lib/schemas';

export type EmailData = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  message: string;
  attachments: File[];
  fromEmail?: string;
  scheduleAt?: string;
};

type SerializableEmailData = Omit<EmailData, 'attachments'> & {
  attachments: Awaited<ReturnType<typeof serializeFiles>>;
};

export const useUndoSend = () => {
  const trpc = useTRPC();
  const { mutateAsync: unsendEmail } = useMutation(trpc.mail.unsend.mutationOptions());

  const handleUndoSend = (result: unknown, emailData?: EmailData) => {
    const storageKey = undoStorageKey();
    const cancel = async (messageId: string) => {
      if (!storageKey || undoStorageKey() !== storageKey) {
        throw new Error('Switch back to the original mailbox to cancel this message.');
      }
      await unsendEmail({ messageId });
    };
    if (isSendResult(result)) {
      const { messageId, sendAt } = result;

      const timeRemaining = sendAt ? Math.max(0, sendAt - Date.now()) : 0;
      const wasUserScheduled = Boolean(emailData?.scheduleAt);

      if (timeRemaining > 0) {
        if (wasUserScheduled) {
          toast.success('Email scheduled', {
            action: {
              label: 'Undo',
              onClick: async () => {
                try {
                  await cancel(messageId);
                  toast.info('Schedule cancelled');
                } catch {
                  toast.error('Failed to cancel');
                }
              },
            },
            duration: Math.min(timeRemaining, 30_000),
            closeButton: true,
          });
        } else {
          toast.success('Queued to send', {
            action: {
              label: 'Undo',
              onClick: async () => {
                try {
                  await cancel(messageId);

                  if (emailData) {
                    const serializedAttachments = await serializeFiles(emailData.attachments);
                    const serializableData: SerializableEmailData = {
                      ...emailData,
                      attachments: serializedAttachments,
                    };
                    const key = storageKey;
                    if (key) {
                      try {
                        sessionStorage.setItem(key, JSON.stringify(serializableData));
                      } catch {
                        toast.info('Send cancelled. The original is available in Scheduled.');
                      }
                    }
                  }

                  if (undoStorageKey() !== storageKey) return;
                  const url = new URL(window.location.href);
                  url.searchParams.delete('activeReplyId');
                  url.searchParams.delete('mode');
                  url.searchParams.delete('draftId');
                  url.searchParams.set('isComposeOpen', 'true');
                  window.history.replaceState({}, '', url.toString());

                  toast.info('Send cancelled');
                } catch {
                  toast.error('Failed to cancel');
                }
              },
            },
            duration: Math.min(timeRemaining, 30_000),
            closeButton: true,
          });
        }
      } else toast.success('Queued to send');
    }
  };

  return { handleUndoSend };
};
