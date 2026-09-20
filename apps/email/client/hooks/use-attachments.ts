import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';

/**
 * Prepare an attachment-byte query without running it during normal message
 * rendering. Callers explicitly refetch after an open/download action.
 */
export const useAttachments = (messageId: string, folder?: string) => {
  const trpc = useTRPC();
  const AttachmentsQuery = useQuery(
    trpc.mail.getMessageAttachments.queryOptions(
      { messageId, folder },
      {
        enabled: false,
        staleTime: 1000 * 60 * 60,
        gcTime: 1000 * 60 * 5,
      },
    ),
  );

  return AttachmentsQuery;
};
