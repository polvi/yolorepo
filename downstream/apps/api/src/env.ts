export type Env = {
  DB: D1Database;
  BASE_DOMAIN?: string;
  AUTH_ENDPOINT?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

export function baseDomainOf(env: Env): string {
  return env.BASE_DOMAIN || "proc.io";
}

/** Origin of this API worker, e.g. https://api.downstream.proc.io */
export function apiOrigin(env: Env): string {
  return `https://api.downstream.${baseDomainOf(env)}`;
}

/** Origin of the public site, e.g. https://downstream.proc.io */
export function webOrigin(env: Env): string {
  return `https://downstream.${baseDomainOf(env)}`;
}

/** RFC 8707 canonical resource URI of the MCP endpoint. */
export function mcpResource(env: Env): string {
  return `${apiOrigin(env)}/mcp`;
}
