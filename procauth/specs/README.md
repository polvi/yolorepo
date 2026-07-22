# ProcAuth TLA+ Specs

Formal safety model of ProcAuth: the shared first-party auth surface at
auth.proc.io that serves login, register, and account pages for every
*.proc.io app and drives AuthGravity's raw API from the browser.
`ProcAuth.tla` and `ProcAuth.cfg` are the exact spec and configuration that
passed TLC model checking (2,186 states generated, 1,412 distinct, full search
to depth 10, no violations). Hub record:
https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/ProcAuth

## What is modeled

All ceremony kinds (WebAuthn passkey create/get, HKDF account-key signature,
silent device-key login) share one challenge/verify shape and are modeled as a
single abstract ceremony against a bounded clock:

- **Issue**: `GET /v1/{register,login}/options` mints a fresh challenge bound
  to the requesting principal; the `return_to` target is accepted only when it
  is an allowlisted *.proc.io app.
- **Verify**: `POST /v1/{register,login}/verify` (or `/v1/key/...`) accepts a
  challenge only if it is fresh (never used) and no older than `TTL` ticks
  (abstracting the real 5-minute expiry), consumes it, creates the session,
  and redirects the browser to the challenge's validated `return_to`. The
  session_id cookie lives on the proc.io registrable domain, so one sign-in is
  valid across every *.proc.io app.
- **Logout**: `POST /v1/logout` destroys the session.

Apps themselves (openmonkey and the rest) stay out of this model: they consume
auth as an abstract session gate by forwarding the cookie to `/v1/whoami`.

## Invariants and properties checked

1. **SessionBackedByOwnChallenge**: every active session is backed by a
   consumed challenge issued to exactly that principal.
2. **ChallengeSingleUse**: a challenge backs at most one session.
3. **VerifiedWithinTTL**: expired challenges never create sessions.
4. **RedirectsOnlyToAllowed**: an authenticated browser is only ever redirected
   to an allowlisted *.proc.io target, and every live challenge carries a
   validated `return_to` (no open redirect).
5. **TypeOK** as a supporting invariant.

Action properties: **NoChallengeReplay** (a used challenge stays used forever)
and **ChallengeBindingImmutable** (owner, `return_to`, and issue time never
change after issuance).

## Finiteness and symmetry choices

- Constants: 2 users, 2 challenge slots, clock bounded to 3 ticks, TTL 1,
  targets {app1, evil} with only app1 allowlisted.
- Challenge identities are ordered slots allocated lowest-free-slot first,
  removing slot-labeling symmetry.
- One session per user (a re-login replaces the cookie); CORS transport is not
  state and is out of scope.

## Re-checking

Run the spec and config through the `tlc_check` MCP tool (or TLC with the
`.cfg`) unchanged. Keep updates in lockstep with architecture changes, and
only commit `.tla`/`.cfg` pairs that pass.
