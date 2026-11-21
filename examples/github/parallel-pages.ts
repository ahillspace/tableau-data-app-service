export async function loadPagesTogether(...pages: Promise<void>[]): Promise<void> {
  // Each pager updates its own rows and cursor. Keep the caller busy until no pager can write.
  const results = await Promise.allSettled(pages);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}
