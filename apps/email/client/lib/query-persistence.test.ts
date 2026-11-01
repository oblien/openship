import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query';
import { shouldPersistQuery } from './query-persistence';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => client.clear());

describe('persisting the webmail query cache', () => {
  it('omits pending and failed queries so the snapshot can be stored in IndexedDB', async () => {
    void client.fetchQuery({ queryKey: [['labels', 'list']], queryFn: () => new Promise(() => {}) }).catch(() => {});
    await client.fetchQuery({ queryKey: [['connections', 'list']], queryFn: async () => { throw new Error('offline'); } }).catch(() => {});
    client.setQueryData([['settings', 'get']], { theme: 'light' });

    const snapshot = structuredClone(dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }));
    expect(snapshot.queries.map(query => query.queryKey)).toEqual([[['settings', 'get']]]);
    const restored = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    try {
      hydrate(restored, snapshot);
      expect(restored.getQueryData<{ theme: string }>([['settings', 'get']])).toEqual({ theme: 'light' });
    } finally { restored.clear(); }
  });

  it('still excludes successful mail and draft contents', () => {
    for (const root of ['mail', 'drafts', 'settings', 'labels']) {
      client.setQueryData([[root, 'list']], { root });
    }
    const snapshot = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery });
    expect(snapshot.queries.map(query => query.queryKey)).toEqual([
      [['settings', 'list']], [['labels', 'list']],
    ]);
  });

  it('retains the last successful settings while a background refresh is running', () => {
    const key = [['settings', 'get']];
    client.setQueryData(key, { theme: 'dark' });
    void client.fetchQuery({ queryKey: key, queryFn: () => new Promise(() => {}) }).catch(() => {});
    const snapshot = structuredClone(dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }));
    expect(snapshot.queries).toHaveLength(1);
    expect(snapshot.queries[0].state.data).toEqual({ theme: 'dark' });
  });
});
