/** the Live Host's JSON routes from the extension host — Bearer = the signed-in
 *  session id or the dev token (both are accepted by the REST routes) */
export async function hostJson<T>(
  url: string,
  opts: { token?: string; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // not JSON — the status is the message
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}
