// Server-side helper: call the registry API via service binding when deployed,
// falling back to the public URL in local dev.

export async function apiFetch(locals: any, path: string): Promise<any> {
  const url = `https://api.openmonkey.proc.io/api${path}`;
  const binding = locals?.runtime?.env?.API;
  const res = binding ? await binding.fetch(new Request(url)) : await fetch(url);
  if (!res.ok) return null;
  return res.json();
}
