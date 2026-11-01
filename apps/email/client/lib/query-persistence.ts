import { defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';

/** Keep transient requests and mailbox contents out of the durable UI cache. */
export function shouldPersistQuery(query: Query): boolean {
  if (!defaultShouldDehydrateQuery(query)) return false;
  const head = query.queryKey[0];
  const root = Array.isArray(head) ? head[0] : undefined;
  return root !== 'mail' && root !== 'drafts';
}
