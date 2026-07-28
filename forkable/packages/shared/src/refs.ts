export const REF_MAIN = 'refs/heads/main';

const FORK_PREFIX = 'refs/forks/';

export function forkRefFor(userId: string): string {
  return `${FORK_PREFIX}${userId}`;
}

export function parseForkRef(ref: string): string | null {
  if (!ref.startsWith(FORK_PREFIX)) return null;
  const userId = ref.slice(FORK_PREFIX.length);
  if (!userId || userId.includes('/')) return null;
  return userId;
}
