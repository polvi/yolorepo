export function llmsTxt(hostname: string): string {
  const origin = `https://${hostname}`;
  return `# tabby

Splitwise for Monero: group expense tracking for friends who settle up in XMR
via Cake Wallet (or any wallet that handles monero: URIs).

- Expenses are entered in USD, CAD, or TAB (a custom unit: 1 TAB = 10 USD).
- The ledger normalizes everything to integer µTAB (100,000 per TAB); balances
  are derived from expenses and payments, never stored.
- Settlement is a greedy minimal-transfer simplification (at most n-1
  transfers), recomputed live.
- Each suggested transfer renders a monero: deep link and QR at the current
  XMR rate; the payer marks it paid (no on-chain verification).
- Cash settlements are first-class: any amount in USD/CAD/TAB ("they handed
  me $300") applies straight to the payer's balance, recordable by either
  party, so even ghost members can settle in cash.

## Auth

Accounts are passkeys via ${origin.replace(/^https:\/\/tabby\./, 'https://auth.')}
(AuthGravity, https://authgravity.org). All API routes under ${origin}/api
require a session cookie; there is no public read API.

## Joining

Group membership is by invite link: ${origin}/join/<token>.

Built on Cloudflare Workers. An Infinite Logic PBC (https://infinitelogic.org)
playground project.
`;
}
