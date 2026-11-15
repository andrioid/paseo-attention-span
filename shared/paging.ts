// Every page of a Paseo list; a failed page fails the whole list, so it's never mistaken for a shorter one [ATT-22].
export interface Page<E> {
  entries: E[];
  pageInfo: { hasMore: boolean; nextCursor?: string | null };
}

export async function everyPage<E>(list: (page: { limit: number; cursor?: string }) => Promise<Page<E>>): Promise<E[]> {
  const entries: E[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await list({ limit: 200, ...(cursor ? { cursor } : {}) });
    entries.push(...result.entries);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return entries;
    cursor = result.pageInfo.nextCursor;
  }
}
