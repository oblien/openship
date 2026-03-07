import { useState, useEffect } from 'react';
import { aiApi } from '@/lib/api';

interface Session {
  id: string;
  sessionId?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

interface UseSessionsOptions {
  agentId?: string | null;
  namespace?: string | null;
  limit?: number;
  autoFetch?: boolean;
}

export function useSessions({ 
  agentId = null, 
  namespace = null, 
  limit = 50,
  autoFetch = true 
}: UseSessionsOptions = {}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await aiApi.listSessions({
        limit,
        agent_id: agentId ?? undefined,
        namespace: namespace ?? undefined,
      });
      
      if (response.success && response.data) {
        // Normalize session data - handle both id and sessionId
        const normalized = response.data.map((session: any) => ({
          id: session.id || session.sessionId,
          sessionId: session.id || session.sessionId,
          title: session.title || 'Untitled',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
        }));
        setSessions(normalized);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch sessions'));
      console.error('Error fetching sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (autoFetch) {
      fetchSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, namespace, limit, autoFetch]);

  const addSession = (session: Session) => {
    setSessions(prev => {
      // Check if already exists
      if (prev.some(s => s.id === session.id || s.sessionId === session.id)) {
        return prev;
      }
      return [session, ...prev];
    });
  };

  const updateSession = (sessionId: string, updates: Partial<Session>) => {
    setSessions(prev => 
      prev.map(s => 
        (s.id === sessionId || s.sessionId === sessionId) 
          ? { ...s, ...updates }
          : s
      )
    );
  };

  const removeSession = (sessionId: string) => {
    setSessions(prev => 
      prev.filter(s => s.id !== sessionId && s.sessionId !== sessionId)
    );
  };

  return {
    sessions,
    loading,
    error,
    fetchSessions,
    addSession,
    updateSession,
    removeSession,
  };
}

