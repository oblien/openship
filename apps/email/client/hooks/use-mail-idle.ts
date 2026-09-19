import { useEffect, useRef } from 'react';
import { BACKEND_URL } from '@/lib/backend-url';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';

export function useMailIdle(folder: string | undefined) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const watchFolder = folder || 'INBOX';
    const url = `${BACKEND_URL}/mail/idle?folder=${encodeURIComponent(watchFolder)}`;
    
    const eventSource = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('mailbox', () => {
      
      queryClient.invalidateQueries({
        queryKey: trpc.mail.listThreads.queryKey(),
      });

      
    });

    eventSource.addEventListener('error', (err) => {
      console.error('Mail IDLE EventSource error:', err);
     
    });

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };


  }, [folder]);
}
