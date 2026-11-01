import type { SSEStreamingApi } from 'hono/streaming';
import type { ImapFlow } from 'imapflow';

/** Own one IMAP connection for exactly the lifetime of its SSE response. */
export async function bridgeImapIdle(
  client: ImapFlow,
  stream: SSEStreamingApi,
  folder: string,
  signal: AbortSignal,
): Promise<void> {
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let writing = false;
  let changed = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    client.removeListener('exists', onChange);
    client.removeListener('expunge', onChange);
    client.removeListener('flags', onChange);
    // LOGOUT is another network command and can wait behind IDLE or a lost
    // connection. close() cancels the socket and pending IMAP commands now.
    client.close();
  };

  // Coalesce mailbox events while the browser is slow. Neither events nor
  // heartbeats may accumulate an unbounded queue of pending SSE writes.
  const flush = async () => {
    if (stopped || writing) return;
    writing = true;
    try {
      if (!changed) await stream.writeSSE({ event: 'ping', data: '{}' });
      while (changed && !stopped) {
        changed = false;
        await stream.writeSSE({ event: 'mailbox', data: JSON.stringify({ folder, at: new Date().toISOString() }) });
      }
    } catch {
      stop();
    } finally {
      writing = false;
    }
  };
  const onChange = () => {
    changed = true;
    void flush();
  };
  const onError = () => stop();

  // Register before connect/mailboxOpen/idle: each can be interrupted by a
  // browser navigating away. onAbort does not replay an earlier abort.
  stream.onAbort(stop);
  signal.addEventListener('abort', stop, { once: true });
  client.on('error', onError);
  client.on('close', stop);
  try {
    if (stream.aborted || signal.aborted) return;
    await client.connect();
    if (stopped) return;
    await client.mailboxOpen(folder);
    if (stopped) return;
    client.on('exists', onChange);
    client.on('expunge', onChange);
    client.on('flags', onChange);
    // Catch up only after selection/listener registration. The browser's
    // HTTP open event can precede IMAP readiness and miss delivery in between.
    onChange();
    heartbeat = setInterval(() => { void flush(); }, 25_000);
    heartbeat.unref?.();
    // ImapFlow renews IDLE through maxIdleTime; it also handles the NOOP
    // fallback for servers without IDLE support. No second keepalive loop.
    await client.idle();
  } catch (err) {
    if (!stopped && !stream.aborted && !signal.aborted) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: (err as Error).message }) }).catch(() => {});
    }
  } finally {
    stop();
    signal.removeEventListener('abort', stop);
    client.removeListener('error', onError);
    client.removeListener('close', stop);
  }
}
