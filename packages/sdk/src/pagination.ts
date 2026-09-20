export interface PageRequest { page: number; perPage: number }
export interface Page<T> { data: T[]; total?: number; page?: number; perPage?: number }
export interface PageIteratorOptions { perPage?: number; signal?: AbortSignal }

/** Iterate a named SDK list operation in either native or remote mode. */
export async function* iteratePages<T>(
  load: (input: PageRequest) => Promise<Page<T>>,
  options: PageIteratorOptions = {},
): AsyncGenerator<T> {
  const { perPage = 50, signal } = options;
  if (!Number.isSafeInteger(perPage) || perPage < 1) throw new TypeError("perPage must be a positive integer");
  let seen = 0;
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const result = await load({ page, perPage });
    if (!result || !Array.isArray(result.data) ||
      (result.page !== undefined && result.page !== page) ||
      (result.perPage !== undefined && (!Number.isSafeInteger(result.perPage) || result.perPage < 1)) ||
      (result.total !== undefined && (!Number.isSafeInteger(result.total) || result.total < 0)))
      throw new TypeError("Invalid pagination response");
    for (const item of result.data) {
      signal?.throwIfAborted();
      yield item;
    }
    seen += result.data.length;
    if (!result.data.length || (result.total !== undefined
      ? seen >= result.total
      : result.data.length < (result.perPage ?? perPage))) return;
  }
}
