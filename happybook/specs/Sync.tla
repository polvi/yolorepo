---------------------------- MODULE Sync ----------------------------
(***************************************************************************)
(* State-based last-writer-wins (LWW) sync between a set of clients and a *)
(* single server over a set of record keys.                                *)
(*                                                                         *)
(* Records carry (ts, wid, deleted): a Lamport-bumped wall-clock          *)
(* timestamp, a globally unique write id used as a tie-breaker, and a      *)
(* tombstone flag.  Deletes are ordinary writes with deleted = TRUE; the   *)
(* row is kept.  The LWW rule is identical on client and server: an        *)
(* incoming record wins iff (in.ts, in.wid) > (cur.ts, cur.wid)            *)
(* lexicographically.                                                      *)
(*                                                                         *)
(* Clients push dirty records; the server appends every accepted record    *)
(* to an append-only log with a dense sequence number.  Clients pull log   *)
(* entries past their cursor and apply LWW locally, which in particular    *)
(* skips overwriting a dirty local record that wins LWW (it will be        *)
(* re-pushed).  A push answered `stale` clears the dirty flag; the         *)
(* server's newer record reaches the client through a later pull.          *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Clients,      \* set of client ids (model values)
    Keys,         \* set of record keys (model values)
    MaxClock,     \* bound on the abstract clock
    MaxWrites,    \* bound on the total number of Write/Delete actions
    NoRec         \* model value: "no record for this key"

VARIABLES
    local,        \* local[c][k]  : client record [ts, wid, deleted, dirty] or NoRec
    cursor,       \* cursor[c]    : highest server seq the client has pulled
    lastClock,    \* lastClock[c] : Lamport-bumped wall clock, max ts observed
    store,        \* store[k]     : server record [ts, wid, deleted] or NoRec
    log,          \* append-only server log; seq i is log[i]
    nextWid,      \* global fresh-write-id counter (uniqueness of tie-breaker)
    writeCount    \* total writes so far, bounds the state space

vars == <<local, cursor, lastClock, store, log, nextWid, writeCount>>

nextSeq == Len(log) + 1

LocalRec == [ts: 1..MaxClock, wid: 1..MaxWrites,
             deleted: BOOLEAN, dirty: BOOLEAN]
SrvRec   == [ts: 1..MaxClock, wid: 1..MaxWrites, deleted: BOOLEAN]
LogEntry == [key: Keys, ts: 1..MaxClock, wid: 1..MaxWrites, deleted: BOOLEAN]

Max(a, b) == IF a >= b THEN a ELSE b

\* The one LWW rule, shared by client and server:
\* a beats b iff (a.ts, a.wid) > (b.ts, b.wid) lexicographically.
Wins(a, b) == \/ a.ts > b.ts
              \/ (a.ts = b.ts /\ a.wid > b.wid)

\* Strip client-only bookkeeping for comparison with the server store.
View(r) == [ts |-> r.ts, wid |-> r.wid, deleted |-> r.deleted]

-----------------------------------------------------------------------------

Init ==
    /\ local      = [c \in Clients |-> [k \in Keys |-> NoRec]]
    /\ cursor     = [c \in Clients |-> 0]
    /\ lastClock  = [c \in Clients |-> 0]
    /\ store      = [k \in Keys |-> NoRec]
    /\ log        = <<>>
    /\ nextWid    = 1
    /\ writeCount = 0

\* A local write or delete: fresh Lamport-bumped ts, fresh wid, dirty.
DoWrite(c, k, del) ==
    /\ writeCount < MaxWrites
    /\ lastClock[c] + 1 <= MaxClock
    /\ LET ts == lastClock[c] + 1 IN
       /\ local' = [local EXCEPT ![c][k] =
                       [ts |-> ts, wid |-> nextWid,
                        deleted |-> del, dirty |-> TRUE]]
       /\ lastClock'  = [lastClock EXCEPT ![c] = ts]
       /\ nextWid'    = nextWid + 1
       /\ writeCount' = writeCount + 1
       /\ UNCHANGED <<cursor, store, log>>

Write(c, k)  == DoWrite(c, k, FALSE)
Delete(c, k) == DoWrite(c, k, TRUE)

\* Push one dirty record.  The server applies LWW; an accepted record is
\* appended to the log with seq = nextSeq.  Whether the reply is `applied`
\* or `stale`, the client clears the dirty flag (stale means the server
\* already holds a newer record; a later pull overwrites local).
PushOne(c, k) ==
    /\ local[c][k] # NoRec
    /\ local[c][k].dirty
    /\ LET r       == local[c][k]
           srv     == View(r)
           applied == store[k] = NoRec \/ Wins(srv, store[k])
       IN /\ IF applied
             THEN /\ store' = [store EXCEPT ![k] = srv]
                  /\ log'   = Append(log, [key |-> k, ts |-> r.ts,
                                           wid |-> r.wid, deleted |-> r.deleted])
             ELSE UNCHANGED <<store, log>>
          /\ local' = [local EXCEPT ![c][k].dirty = FALSE]
          /\ UNCHANGED <<cursor, lastClock, nextWid, writeCount>>

\* Pull the next log entry past the cursor and apply LWW against local.
\* This skips overwriting a dirty local record that wins LWW (it will be
\* re-pushed), and also skips the echo of the client's own pushed writes.
\* lastClock absorbs the ts of every pulled record, applied or skipped.
PullOne(c) ==
    /\ cursor[c] < Len(log)
    /\ LET e     == log[cursor[c] + 1]
           k     == e.key
           l     == local[c][k]
           erec  == [ts |-> e.ts, wid |-> e.wid,
                     deleted |-> e.deleted, dirty |-> FALSE]
           takes == l = NoRec \/ Wins(erec, l)
       IN /\ local'     = IF takes THEN [local EXCEPT ![c][k] = erec] ELSE local
          /\ cursor'    = [cursor EXCEPT ![c] = cursor[c] + 1]
          /\ lastClock' = [lastClock EXCEPT ![c] = Max(lastClock[c], e.ts)]
          /\ UNCHANGED <<store, log, nextWid, writeCount>>

Next ==
    \E c \in Clients:
        \/ \E k \in Keys: Write(c, k) \/ Delete(c, k) \/ PushOne(c, k)
        \/ PullOne(c)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
    /\ local  \in [Clients -> [Keys -> LocalRec \cup {NoRec}]]
    /\ cursor \in [Clients -> 0..MaxWrites]
    /\ lastClock \in [Clients -> 0..MaxClock]
    /\ store  \in [Keys -> SrvRec \cup {NoRec}]
    /\ log    \in Seq(LogEntry)
    /\ Len(log) <= writeCount
    /\ nextWid \in 1..MaxWrites + 1
    /\ writeCount \in 0..MaxWrites

\* (1) Quiescence convergence: with no dirty records anywhere and every
\* client fully caught up, every client's local state equals the store,
\* tombstones included.
Quiescent ==
    /\ \A c \in Clients, k \in Keys:
           local[c][k] = NoRec \/ ~local[c][k].dirty
    /\ \A c \in Clients: cursor[c] = nextSeq - 1

Convergence ==
    Quiescent =>
        \A c \in Clients, k \in Keys:
            IF local[c][k] = NoRec
            THEN store[k] = NoRec
            ELSE store[k] # NoRec /\ View(local[c][k]) = store[k]

\* (2) NoResurrection: the store always holds the LWW-maximal record ever
\* accepted for each key.  Because the log is append-only, this makes
\* store[k].(ts, wid) monotonically nondecreasing: a tombstone with the
\* maximal (ts, wid) can never be replaced by a smaller live record.
EntriesFor(k) == {i \in 1..Len(log): log[i].key = k}

ServerStoreIsLogMax ==
    \A k \in Keys:
        IF EntriesFor(k) = {}
        THEN store[k] = NoRec
        ELSE /\ store[k] # NoRec
             /\ \E i \in EntriesFor(k):
                    store[k] = [ts |-> log[i].ts, wid |-> log[i].wid,
                                deleted |-> log[i].deleted]
             /\ \A i \in EntriesFor(k): ~Wins(log[i], store[k])

\* (3) NoLostAck / log shape: seq values are exactly 1..nextSeq-1 (dense,
\* by the sequence representation) and every entry is well-formed; write
\* ids in the log are unique, so the LWW tie-breaker is total.
LogSeqDense ==
    /\ nextSeq = Len(log) + 1
    /\ \A i \in 1..Len(log): log[i] \in LogEntry
    /\ \A i, j \in 1..Len(log): i # j => log[i].wid # log[j].wid

\* (4) Cursor bound: a cursor never exceeds nextSeq - 1.
CursorInRange ==
    \A c \in Clients: cursor[c] \in 0..(nextSeq - 1)

-----------------------------------------------------------------------------
(* Action properties: immutability and monotonicity across every step. *)

\* Log entries never change once written; the log only grows.
\* Cursors never decrease.  The store record for a key only ever changes
\* to a record that wins LWW over the current one (NoResurrection as a
\* step-level property).
MonotoneStep ==
    /\ Len(log') >= Len(log)
    /\ \A i \in 1..Len(log): log'[i] = log[i]
    /\ \A c \in Clients: cursor'[c] >= cursor[c]
    /\ \A k \in Keys:
           store[k] # NoRec =>
               /\ store'[k] # NoRec
               /\ store'[k] # store[k] => Wins(store'[k], store[k])

Safety == [][MonotoneStep]_vars

=============================================================================
