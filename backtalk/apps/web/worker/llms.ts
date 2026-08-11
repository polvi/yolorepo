export function llmsTxt(hostname: string): string {
  const origin = `https://${hostname}`;
  const authOrigin = origin.replace(/^https:\/\/backtalk\./, 'https://auth.');
  return `# backtalk

Sentry meets a suggestion box, wired into the site owner's coding agent.
Sites embed one script; visitors submit feedback through a hidden UI and
JavaScript errors are captured automatically. A coding agent (like Claude
Code) reads both over MCP, offers to implement fixes, and marks items done
with a note the original submitter sees in the widget ("shipped").

## Embed (site owners)

<script src="${origin}/w.js" data-key="pk_..." data-release="v1" defer></script>

- Hidden feedback UI: Cmd/Ctrl+Shift+/ on desktop, two-finger long-press on
  touch, or window.backtalk.open(). Kinds: bug, idea, feedback.
- Error capture: window.onerror + unhandledrejection, grouped server-side by
  fingerprint, with a breadcrumb trail (clicks, navigations, console errors).
- Web Vitals (LCP/INP/CLS) and pageviews as daily rollups; no cookies, no IPs.
- data-release tags events so a resolved error recurring in a NEW release is
  flagged as a regression.
- window.backtalk.set({...}) attaches metadata; window.backtalk.capture(err)
  reports a handled exception.

Create a project and get your pk_ key at ${origin} (passkey account).

## MCP (coding agents)

claude mcp add --transport http backtalk ${origin}/mcp --header "Authorization: Bearer bt_..."

Mint bt_ tokens at ${origin}/#/settings (requires a passkey session; the
plaintext is shown once). Tools:

- projects_list — your projects with new-feedback / open-error counts
- feedback_list, feedback_get — visitor-submitted bugs/ideas/feedback with breadcrumbs
- feedback_set_status — seen/planned/done/declined; done+note = the submitter sees "shipped"
- errors_list, errors_get — fingerprint-grouped JS errors with sample stacks
- errors_set_status — resolve after fixing; reoccurrence auto-flags "regressed"
- stats_overview — Web Vitals rollups + daily pageviews

The intended loop: list open errors and new feedback, offer your user fixes,
ship them, then set statuses with notes written for the person who reported.

## Ingest API (custom clients)

POST ${origin}/api/ingest with a text/plain JSON body (sendBeacon-friendly):
{ "key": "pk_...", "release": "v1", "events": [
  { "type": "feedback", "id": "<uuid>", "kind": "bug|idea|feedback", "message": "..." },
  { "type": "error", "id": "<uuid>", "message": "...", "stack": "..." },
  { "type": "vital", "metric": "LCP|INP|CLS", "value": 1234.5, "path": "/" },
  { "type": "pageview", "path": "/" } ] }
Event ids are client-generated UUIDs; retries are idempotent. Responses are
always 200 with {accepted, dropped} — never retry dropped events.
GET ${origin}/api/submissions?key=pk_...&ids=<uuid>,... returns status +
resolution note for ids the caller holds (how the widget closes the loop).

## Auth

Accounts are passkeys via ${authOrigin} (AuthGravity,
https://authgravity.org). Dashboard API routes under ${origin}/api require a
session cookie or a bt_ bearer token.

Built on Cloudflare Workers. An Infinite Logic PBC (https://infinitelogic.org)
playground project.
`;
}
