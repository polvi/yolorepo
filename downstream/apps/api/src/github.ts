// Thin GitHub REST client. Uses the signed-in user's OAuth token when
// available (5000 req/h vs 60 unauthenticated, and attribution is real).

const API = "https://api.github.com";
const UA = "downstream-mcp";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function gh(path: string, token?: string | null): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GitHubError(res.status, `GitHub ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export const github = {
  repo: (owner: string, repo: string, token?: string | null) =>
    gh(`/repos/${owner}/${repo}`, token),

  readme: async (owner: string, repo: string, token?: string | null) => {
    try {
      const r = await gh(`/repos/${owner}/${repo}/readme`, token);
      return atobUtf8(r.content);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  },

  tree: async (owner: string, repo: string, ref: string, recursive: boolean, token?: string | null) =>
    gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}${recursive ? "?recursive=1" : ""}`, token),

  file: async (owner: string, repo: string, path: string, ref?: string, token?: string | null) => {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const r = await gh(`/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`, token);
    if (Array.isArray(r)) {
      return { type: "dir", entries: r.map((e: any) => ({ name: e.name, type: e.type, size: e.size })) };
    }
    if (r.encoding === "base64" && r.content != null) {
      return { type: "file", path: r.path, size: r.size, content: atobUtf8(r.content) };
    }
    return { type: r.type, path: r.path, size: r.size, note: "content not inlined (too large or binary); use the download_url", download_url: r.download_url };
  },

  searchCode: (owner: string, repo: string, query: string, token?: string | null) =>
    gh(`/search/code?q=${encodeURIComponent(`${query} repo:${owner}/${repo}`)}&per_page=20`, token),

  user: (token: string) => gh("/user", token),
};

function atobUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
