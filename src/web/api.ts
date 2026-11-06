export async function api<T>(url: string, body?: unknown, method?: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<T> {
  const endpoint = new URL(`api${url}`, document.baseURI);
  const r = await fetch(endpoint, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'Algo ha fallado');
  return j;
}

/** Resolve stored /images/... paths relative to the app mount point. */
export function appAssetUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).toString();
}
