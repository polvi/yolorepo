---------------------------- MODULE DownstreamAuth ----------------------------
(***************************************************************************)
(* Safety model of a stateless-HTTP MCP worker acting as its own OAuth     *)
(* 2.1 authorization server with PKCE, fronting an upstream IdP.           *)
(*                                                                         *)
(* The upstream (GitHub) leg is abstracted away: IssueCode models the      *)
(* /callback step after the worker has already verified the upstream code  *)
(* and created the user row.  From there:                                  *)
(*                                                                         *)
(*   - IssueCode: worker mints a single-use authorization code bound to    *)
(*     the requesting client (its redirect_uri + PKCE code_challenge).     *)
(*     Owning a code in this model means owning the PKCE verifier for it.  *)
(*   - StealCode: an attacker observes the code string in transit (e.g.    *)
(*     leaked redirect) but never learns the code_verifier.                *)
(*   - BeginRedeem / CommitMint / RejectRedeem: a /token request is        *)
(*     two-phase, mirroring a Worker + D1 implementation: first a read     *)
(*     that sees the code row as redeemable, then a separate write that    *)
(*     inserts the token and marks the code redeemed.  Multiple requests   *)
(*     for the same code may be in flight concurrently (isolate-level      *)
(*     concurrency, client retries, attacker replay).                      *)
(*   - ExpireCode: a code's TTL elapses before it is consumed.            *)
(*   - Revoke / UseToken: bearer tokens can be revoked; every resource     *)
(*     request is authenticated against the current token row.            *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
  Clients,     \* registered OAuth clients, including attacker-controlled ones
  Attackers,   \* attacker-controlled clients: can steal code strings, never verifiers
  Codes,       \* pool of authorization-code identities
  Tokens,      \* pool of bearer-token identities
  MaxInflight, \* max concurrent /token requests per (code, client)
  NoClient,    \* model value: "no client"
  NoCode       \* model value: "no code"

ASSUME Attackers \subseteq Clients
ASSUME NoClient \notin Clients
ASSUME NoCode \notin Codes
ASSUME MaxInflight \in Nat \ {0}

CodeStates == {"free", "issued", "redeemed", "expired"}
TokStates  == {"free", "active", "revoked"}

VARIABLES
  codeSt,     \* Codes -> code lifecycle state
  codeOwner,  \* Codes -> client whose redirect_uri + PKCE challenge the code is bound to
  stolen,     \* subset of Codes whose string an attacker has observed
  inflight,   \* (Codes \X Clients) -> Nat : /token requests past the read phase
  tokSt,      \* Tokens -> token lifecycle state
  tokOwner,   \* Tokens -> client the token was issued to
  tokCode,    \* Tokens -> authorization code the token was minted from
  mintCodeSt, \* Tokens -> code state observed at mint time (history, for ExpiredCodesNeverMint)
  authLog     \* history of resource-request authentication decisions

vars == <<codeSt, codeOwner, stolen, inflight, tokSt, tokOwner, tokCode,
          mintCodeSt, authLog>>

TypeOK ==
  /\ codeSt \in [Codes -> CodeStates]
  /\ codeOwner \in [Codes -> Clients \cup {NoClient}]
  /\ stolen \subseteq Codes
  /\ inflight \in [Codes \X Clients -> 0..MaxInflight]
  /\ tokSt \in [Tokens -> TokStates]
  /\ tokOwner \in [Tokens -> Clients \cup {NoClient}]
  /\ tokCode \in [Tokens -> Codes \cup {NoCode}]
  /\ mintCodeSt \in [Tokens -> CodeStates \cup {"none"}]
  /\ authLog \subseteq [tok: Tokens, ok: BOOLEAN, st: TokStates]

Init ==
  /\ codeSt = [c \in Codes |-> "free"]
  /\ codeOwner = [c \in Codes |-> NoClient]
  /\ stolen = {}
  /\ inflight = [p \in Codes \X Clients |-> 0]
  /\ tokSt = [t \in Tokens |-> "free"]
  /\ tokOwner = [t \in Tokens |-> NoClient]
  /\ tokCode = [t \in Tokens |-> NoCode]
  /\ mintCodeSt = [t \in Tokens |-> "none"]
  /\ authLog = {}

(***************************************************************************)
(* /callback: upstream identity verified; worker issues its own            *)
(* single-use code bound to the client's redirect_uri + code_challenge.    *)
(***************************************************************************)
IssueCode(c, cl) ==
  /\ codeSt[c] = "free"
  /\ codeSt' = [codeSt EXCEPT ![c] = "issued"]
  /\ codeOwner' = [codeOwner EXCEPT ![c] = cl]
  /\ UNCHANGED <<stolen, inflight, tokSt, tokOwner, tokCode, mintCodeSt, authLog>>

\* Code TTL elapses before the code is consumed.
ExpireCode(c) ==
  /\ codeSt[c] = "issued"
  /\ codeSt' = [codeSt EXCEPT ![c] = "expired"]
  /\ UNCHANGED <<codeOwner, stolen, inflight, tokSt, tokOwner, tokCode,
                 mintCodeSt, authLog>>

\* Attacker observes the code string (leaked redirect, logs), not the verifier.
StealCode(c) ==
  /\ codeSt[c] = "issued"
  /\ c \notin stolen
  /\ stolen' = stolen \cup {c}
  /\ UNCHANGED <<codeSt, codeOwner, inflight, tokSt, tokOwner, tokCode,
                 mintCodeSt, authLog>>

\* cl can present the code string at /token.
Possesses(cl, c) ==
  \/ cl = codeOwner[c]
  \/ (c \in stolen /\ cl \in Attackers)

(***************************************************************************)
(* /token, read phase: the worker reads the code row and sees it as        *)
(* redeemable (exists, unredeemed, unexpired).  The request is now in      *)
(* flight; other requests for the same code may also be in flight.         *)
(***************************************************************************)
BeginRedeem(c, cl) ==
  /\ codeSt[c] = "issued"
  /\ Possesses(cl, c)
  /\ inflight[<<c, cl>>] < MaxInflight
  /\ inflight' = [inflight EXCEPT ![<<c, cl>>] = @ + 1]
  /\ UNCHANGED <<codeSt, codeOwner, stolen, tokSt, tokOwner, tokCode,
                 mintCodeSt, authLog>>

(***************************************************************************)
(* /token, write phase: PKCE check passed (S256(code_verifier) matches     *)
(* the stored challenge, client_id and redirect_uri match), so the worker  *)
(* inserts the bearer token and marks the code redeemed.                   *)
(*                                                                         *)
(* DESIGN CONSTRAINT (found by TLC): the commit must be an ATOMIC          *)
(* conditional consume of the code row -- in D1 terms                      *)
(*   UPDATE codes SET redeemed = 1                                         *)
(*     WHERE id = ? AND redeemed = 0 AND expires_at > ?                    *)
(* and the token may be inserted only if that UPDATE changed exactly one   *)
(* row.  A naive read-validate-then-write flow (commit without the         *)
(* codeSt[c] = "issued" conjunct below) lets a code expire, or be          *)
(* redeemed by a concurrent duplicate request, between the read and the    *)
(* write: TLC then violates ExpiredCodesNeverMint and SingleUseCodes.      *)
(***************************************************************************)
CommitMint(c, cl, t) ==
  /\ inflight[<<c, cl>>] > 0
  /\ codeSt[c] = "issued"                    \* atomic consume: row still unredeemed+unexpired
  /\ cl = codeOwner[c]                       \* PKCE verifier + client binding check
  /\ tokSt[t] = "free"
  /\ codeSt' = [codeSt EXCEPT ![c] = "redeemed"]
  /\ tokSt' = [tokSt EXCEPT ![t] = "active"]
  /\ tokOwner' = [tokOwner EXCEPT ![t] = cl]
  /\ tokCode' = [tokCode EXCEPT ![t] = c]
  /\ mintCodeSt' = [mintCodeSt EXCEPT ![t] = codeSt[c]]
  /\ inflight' = [inflight EXCEPT ![<<c, cl>>] = @ - 1]
  /\ UNCHANGED <<codeOwner, stolen, authLog>>

\* /token rejects: PKCE mismatch (attacker lacks the verifier), or the
\* atomic consume found the code already redeemed or expired.
RejectRedeem(c, cl) ==
  /\ inflight[<<c, cl>>] > 0
  /\ (cl # codeOwner[c] \/ codeSt[c] # "issued")
  /\ inflight' = [inflight EXCEPT ![<<c, cl>>] = @ - 1]
  /\ UNCHANGED <<codeSt, codeOwner, stolen, tokSt, tokOwner, tokCode,
                 mintCodeSt, authLog>>

\* Token revocation (user- or client-initiated).
Revoke(t) ==
  /\ tokSt[t] = "active"
  /\ tokSt' = [tokSt EXCEPT ![t] = "revoked"]
  /\ UNCHANGED <<codeSt, codeOwner, stolen, inflight, tokOwner, tokCode,
                 mintCodeSt, authLog>>

(***************************************************************************)
(* An MCP request arrives bearing token t.  The worker hashes the token    *)
(* and authenticates against the current stored row: serve iff active.    *)
(* The decision and the row state at decision time are logged (history).  *)
(***************************************************************************)
UseToken(t) ==
  /\ tokSt[t] # "free"
  /\ authLog' = authLog \cup
       {[tok |-> t, ok |-> (tokSt[t] = "active"), st |-> tokSt[t]]}
  /\ UNCHANGED <<codeSt, codeOwner, stolen, inflight, tokSt, tokOwner,
                 tokCode, mintCodeSt>>

Next ==
  \/ \E c \in Codes, cl \in Clients : IssueCode(c, cl)
  \/ \E c \in Codes : ExpireCode(c)
  \/ \E c \in Codes : StealCode(c)
  \/ \E c \in Codes, cl \in Clients : BeginRedeem(c, cl)
  \/ \E c \in Codes, cl \in Clients, t \in Tokens : CommitMint(c, cl, t)
  \/ \E c \in Codes, cl \in Clients : RejectRedeem(c, cl)
  \/ \E t \in Tokens : Revoke(t)
  \/ \E t \in Tokens : UseToken(t)

Spec == Init /\ [][Next]_vars

--------------------------------------------------------------------------------
(* Invariants *)

\* (1) A code is redeemed at most once: no two tokens minted from one code.
SingleUseCodes ==
  \A t1, t2 \in Tokens :
    (t1 # t2 /\ tokSt[t1] # "free" /\ tokSt[t2] # "free")
      => tokCode[t1] # tokCode[t2]

\* (2) A token is only ever held by the client that owns the PKCE verifier
\*     for its code (an attacker with a stolen code string never mints).
TokenBoundToVerifierOwner ==
  \A t \in Tokens :
    tokSt[t] # "free" => tokOwner[t] = codeOwner[tokCode[t]]

\* (3) A revoked token never authenticates a request.
RevokedNeverAuthenticates ==
  \A e \in authLog : e.ok => e.st = "active"

\* (4) An expired code never mints a token.
ExpiredCodesNeverMint ==
  \A t \in Tokens : tokSt[t] # "free" => mintCodeSt[t] = "issued"

================================================================================
