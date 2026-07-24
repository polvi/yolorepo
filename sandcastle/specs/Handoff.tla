------------------------------ MODULE Handoff ------------------------------
(***************************************************************************)
(* Replication and recovery for a memory-only KV store on a substrate     *)
(* that evicts processes at will (Cloudflare Durable Objects).  Three     *)
(* named replicas hold the state in RAM; a fixed Coordinator issues every *)
(* write.  Nothing is ever persisted: an evicted replica reboots empty    *)
(* and must reseed from its peers before serving.                         *)
(*                                                                         *)
(* Records are tagged (ep, ver, wid): the coordinator incarnation epoch,  *)
(* a per-incarnation version counter, and a globally unique write id.     *)
(* Records are ordered lexicographically by (ep, ver) and merged by       *)
(* keep-the-winner (Wins/MergeVal), so a new incarnation never recovers   *)
(* the old counter -- any (ep+1, 1) beats any (ep, n), like Raft terms.   *)
(*                                                                         *)
(* Writes: the coordinator buffers the write as pending, pushes it to     *)
(* both peers, and commits (applies locally + acks the client) on the     *)
(* first peer ack, so an acked write is held by >= 2 replicas.  The ack   *)
(* channel is abstracted away: CommitWrite is enabled exactly when some   *)
(* peer's memory holds the pushed record (or a dominator), which is what  *)
(* an ack witnesses.  The interleaving "peer acks, peer is evicted,       *)
(* commit lands" reaches the same states as commit-then-evict, so no      *)
(* coverage is lost.  Gossip max-merges full state between ready          *)
(* replicas.  In-flight pushes survive their sender's eviction (ghost     *)
(* pushes) -- epoch tags make them harmless, no fencing needed.           *)
(*                                                                         *)
(* Recovery: a peer merges snapshots from all other replicas, then is     *)
(* ready.  The coordinator recovers in two phases, Paxos-prepare style:   *)
(* collect snapshots + highest-heard epochs from all peers, choose        *)
(* epoch := max+1, then announce the new epoch to all peers before        *)
(* serving a single write.  An incarnation that dies before completing    *)
(* announce never wrote, so its epoch may be harmlessly reused; one that  *)
(* wrote is witnessed by every peer, so a later collect must see it.      *)
(*                                                                         *)
(* Eviction is an arbitrary environment action, constrained only so that *)
(* some replica is always ready: the spec covers the non-total-death      *)
(* regime, which is exactly where the store's guarantees apply (total    *)
(* death resets the namespace by design; see DESIGN.md section 6).        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Replicas,     \* set of replica ids (model values)
    Coordinator,  \* the fixed write coordinator, an element of Replicas
    Keys,         \* set of record keys (model values)
    MaxWrites,    \* bound on issued writes; wids are 1..MaxWrites
    MaxEvicts,    \* bound on evictions; also bounds the epoch
    NoVal         \* model value: "no record for this key"

ASSUME Coordinator \in Replicas

Peers    == Replicas \ {Coordinator}
MaxEpoch == MaxEvicts + 1

VARIABLES
    mem,        \* mem[r][k]  : record [ep, ver, wid] or NoVal (served state)
    status,     \* status[r]  : peer "ready"|"recovering";
                \*              coordinator "ready"|"collect"|"announce"
    seeded,     \* seeded[r]  : replicas consulted in the current phase
    known,      \* known[p]   : highest coordinator epoch peer p has heard
    epoch,      \* coordinator's current epoch (0 = not yet chosen)
    collectMax, \* highest epoch seen during the coordinator's collect phase
    verCtr,     \* per-incarnation version counter
    widCtr,     \* next globally unique write id
    pending,    \* coordinator's un-acked writes [key, ep, ver, wid]
    net,        \* in-flight push messages; survive their sender's eviction
    acked,      \* history: writes acked to clients, with a doomed flag
                \* (doomed = an eviction destroyed the last held copy)
    evictCount  \* total evictions so far, bounds the state space

vars == <<mem, status, seeded, known, epoch, collectMax, verCtr, widCtr,
          pending, net, acked, evictCount>>

Rec      == [ep: 1..MaxEpoch, ver: 1..MaxWrites, wid: 1..MaxWrites]
PushMsg  == [dst: Peers, key: Keys,
             ep: 1..MaxEpoch, ver: 1..MaxWrites, wid: 1..MaxWrites]
PendingW == [key: Keys, ep: 1..MaxEpoch, ver: 1..MaxWrites,
             wid: 1..MaxWrites]
AckedW   == [key: Keys, ep: 1..MaxEpoch, ver: 1..MaxWrites,
             wid: 1..MaxWrites, doomed: BOOLEAN]

Max(a, b) == IF a >= b THEN a ELSE b
SetMax(S) == IF S = {} THEN 0 ELSE CHOOSE m \in S : \A x \in S : x <= m

\* Lexicographic (ep, ver) order: the one merge rule everywhere.
Wins(a, b) == \/ a.ep > b.ep
              \/ (a.ep = b.ep /\ a.ver > b.ver)

MergeVal(a, b) == IF a = NoVal THEN b
                  ELSE IF b = NoVal THEN a
                  ELSE IF Wins(b, a) THEN b ELSE a

MergeMem(m, n) == [k \in Keys |-> MergeVal(m[k], n[k])]

MemEpMax(m) == SetMax({m[k].ep : k \in {kk \in Keys : m[kk] # NoVal}})

EmptyMem == [k \in Keys |-> NoVal]

IsReady(r) == status[r] = "ready"

\* r's record for w's key dominates w (holds it or something newer).
Holds(r, w) == mem[r][w.key] # NoVal /\ ~Wins(w, mem[r][w.key])

\* Epoch knowledge a reseed source hands out: the coordinator reports its
\* current epoch directly; a peer reports what it has heard.
SrcKnow(q) == IF q = Coordinator THEN epoch ELSE known[q]

-----------------------------------------------------------------------------

Init ==
    /\ mem        = [r \in Replicas |-> EmptyMem]
    /\ status     = [r \in Replicas |-> "ready"]
    /\ seeded     = [r \in Replicas |-> {}]
    /\ known      = [p \in Peers |-> 1]
    /\ epoch      = 1
    /\ collectMax = 0
    /\ verCtr     = 0
    /\ widCtr     = 1
    /\ pending    = {}
    /\ net        = {}
    /\ acked      = {}
    /\ evictCount = 0

\* A client PUT: the ready coordinator assigns (epoch, verCtr+1, wid),
\* buffers it as pending (never served from there), and pushes to both
\* peers.  It is NOT applied to the coordinator's own memory yet: the
\* coordinator serves only quorum-committed data, so eviction wipes
\* pending without breaking any promise made to a client.
ClientWrite(k) ==
    /\ IsReady(Coordinator)
    /\ widCtr <= MaxWrites
    /\ pending' = pending \cup
           {[key |-> k, ep |-> epoch, ver |-> verCtr + 1,
             wid |-> widCtr]}
    /\ net' = net \cup
           {[dst |-> p, key |-> k, ep |-> epoch,
             ver |-> verCtr + 1, wid |-> widCtr] : p \in Peers}
    /\ verCtr' = verCtr + 1
    /\ widCtr' = widCtr + 1
    /\ UNCHANGED <<mem, status, seeded, known, epoch, collectMax, acked,
                   evictCount>>

\* A peer receives a push: max-merge into memory (late, duplicate, and
\* ghost deliveries are harmless) and absorb the epoch.  Peers accept
\* pushes even while recovering -- a merged record is genuinely held.
DeliverPush(m) ==
    /\ m \in net
    /\ LET rec == [ep |-> m.ep, ver |-> m.ver, wid |-> m.wid] IN
       mem' = [mem EXCEPT ![m.dst][m.key] = MergeVal(@, rec)]
    /\ known' = [known EXCEPT ![m.dst] = Max(@, m.ep)]
    /\ net' = net \ {m}
    /\ UNCHANGED <<status, seeded, epoch, collectMax, verCtr, widCtr,
                   pending, acked, evictCount>>

\* First peer ack = quorum (coordinator + one peer, 2 of 3): apply
\* locally, ack the client (append to the acked history), drop pending.
\* The enabling condition IS the ack, abstracted: some peer's memory
\* holds the pushed record or a dominator of it.
CommitWrite(pw) ==
    /\ pw \in pending
    /\ \E p \in Peers : Holds(p, pw)
    /\ LET rec == [ep |-> pw.ep, ver |-> pw.ver, wid |-> pw.wid] IN
       mem' = [mem EXCEPT ![Coordinator][pw.key] = MergeVal(@, rec)]
    /\ pending' = pending \ {pw}
    /\ acked' = acked \cup {[key |-> pw.key, ep |-> pw.ep, ver |-> pw.ver,
                             wid |-> pw.wid, doomed |-> FALSE]}
    /\ UNCHANGED <<status, seeded, known, epoch, collectMax, verCtr,
                   widCtr, net, evictCount>>

\* The environment evicts a replica: memory, pending, and epoch knowledge
\* are RAM and vanish; in-flight messages in net deliberately survive.
\* An acked write whose last held copy this eviction destroys is stamped
\* doomed at this moment -- the invariants then assert that eviction of
\* the last holder is the ONLY way to lose an acked write.  The exists-a-
\* ready-replica guard scopes the model to the non-total-death regime.
Evict(r) ==
    /\ evictCount < MaxEvicts
    /\ \E s \in Replicas \ {r} : IsReady(s)
    /\ acked' = {[w EXCEPT !.doomed =
                     @ \/ ~\E s \in Replicas \ {r} : Holds(s, w)]
                 : w \in acked}
    /\ mem' = [mem EXCEPT ![r] = EmptyMem]
    /\ seeded' = [seeded EXCEPT ![r] = {}]
    /\ evictCount' = evictCount + 1
    /\ IF r = Coordinator
       THEN /\ status' = [status EXCEPT ![r] = "collect"]
            /\ epoch' = 0
            /\ collectMax' = 0
            /\ verCtr' = 0
            /\ pending' = {}
            /\ UNCHANGED known
       ELSE /\ status' = [status EXCEPT ![r] = "recovering"]
            /\ known' = [known EXCEPT ![r] = 0]
            /\ UNCHANGED <<epoch, collectMax, verCtr, pending>>
    /\ UNCHANGED <<widCtr, net>>

\* Coordinator recovery, phase 1 (collect): take an atomic snapshot from
\* peer p -- merge its memory and absorb the highest epoch it knows of
\* (from heartbeats and from its record tags).  Empty snapshots count.
ReseedC(p) ==
    /\ status[Coordinator] = "collect"
    /\ p \in Peers \ seeded[Coordinator]
    /\ mem' = [mem EXCEPT ![Coordinator] = MergeMem(@, mem[p])]
    /\ collectMax' = Max(collectMax, Max(known[p], MemEpMax(mem[p])))
    /\ seeded' = [seeded EXCEPT ![Coordinator] = @ \cup {p}]
    /\ UNCHANGED <<status, known, epoch, verCtr, widCtr, pending, net,
                   acked, evictCount>>

\* Coordinator recovery, phase boundary: with ALL peers collected, choose
\* the next epoch.  seeded is reused as the announce tracker.
ChooseEpoch ==
    /\ status[Coordinator] = "collect"
    /\ seeded[Coordinator] = Peers
    /\ epoch' = collectMax + 1
    /\ status' = [status EXCEPT ![Coordinator] = "announce"]
    /\ seeded' = [seeded EXCEPT ![Coordinator] = {}]
    /\ UNCHANGED <<mem, known, collectMax, verCtr, widCtr, pending, net,
                   acked, evictCount>>

\* Coordinator recovery, phase 2 (announce): install the chosen epoch at
\* peer p.  Writing before every peer has witnessed the epoch is the bug
\* the announce phase exists to prevent.
AnnounceTo(p) ==
    /\ status[Coordinator] = "announce"
    /\ p \in Peers \ seeded[Coordinator]
    /\ known' = [known EXCEPT ![p] = Max(@, epoch)]
    /\ seeded' = [seeded EXCEPT ![Coordinator] = @ \cup {p}]
    /\ UNCHANGED <<mem, status, epoch, collectMax, verCtr, widCtr,
                   pending, net, acked, evictCount>>

FinishRecoveryC ==
    /\ status[Coordinator] = "announce"
    /\ seeded[Coordinator] = Peers
    /\ status' = [status EXCEPT ![Coordinator] = "ready"]
    /\ UNCHANGED <<mem, seeded, known, epoch, collectMax, verCtr, widCtr,
                   pending, net, acked, evictCount>>

\* Peer recovery: merge an atomic snapshot from every other replica
\* (recovering sources hand over whatever partial state they have; the
\* coordinator also hands over its current epoch), then become ready.
ReseedPeer(p, q) ==
    /\ p \in Peers
    /\ status[p] = "recovering"
    /\ q \in (Replicas \ {p}) \ seeded[p]
    /\ mem' = [mem EXCEPT ![p] = MergeMem(@, mem[q])]
    /\ known' = [known EXCEPT ![p] = Max(@, Max(SrcKnow(q),
                                               MemEpMax(mem[q])))]
    /\ seeded' = [seeded EXCEPT ![p] = @ \cup {q}]
    /\ UNCHANGED <<status, epoch, collectMax, verCtr, widCtr, pending,
                   net, acked, evictCount>>

FinishRecoveryPeer(p) ==
    /\ p \in Peers
    /\ status[p] = "recovering"
    /\ seeded[p] = Replicas \ {p}
    /\ status' = [status EXCEPT ![p] = "ready"]
    /\ UNCHANGED <<mem, seeded, known, epoch, collectMax, verCtr, widCtr,
                   pending, net, acked, evictCount>>

\* Anti-entropy between two ready replicas: symmetric atomic max-merge.
Gossip(a, b) ==
    /\ a \in Replicas /\ b \in Replicas /\ a # b
    /\ IsReady(a) /\ IsReady(b)
    /\ mem' = [mem EXCEPT ![a] = MergeMem(@, mem[b]),
                          ![b] = MergeMem(@, mem[a])]
    /\ UNCHANGED <<status, seeded, known, epoch, collectMax, verCtr,
                   widCtr, pending, net, acked, evictCount>>

Next ==
    \/ \E k \in Keys : ClientWrite(k)
    \/ \E m \in net : DeliverPush(m)
    \/ \E pw \in pending : CommitWrite(pw)
    \/ \E r \in Replicas : Evict(r)
    \/ \E p \in Peers : ReseedC(p) \/ AnnounceTo(p) \/ FinishRecoveryPeer(p)
    \/ ChooseEpoch
    \/ FinishRecoveryC
    \/ \E p \in Peers, q \in Replicas : ReseedPeer(p, q)
    \/ \E a, b \in Replicas : Gossip(a, b)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
    /\ mem \in [Replicas -> [Keys -> Rec \cup {NoVal}]]
    /\ status \in [Replicas -> {"ready", "recovering", "collect",
                                "announce"}]
    /\ \A p \in Peers : status[p] \in {"ready", "recovering"}
    /\ seeded \in [Replicas -> SUBSET Replicas]
    /\ known \in [Peers -> 0..MaxEpoch]
    /\ epoch \in 0..MaxEpoch
    /\ collectMax \in 0..MaxEpoch
    /\ verCtr \in 0..MaxWrites
    /\ widCtr \in 1..MaxWrites + 1
    /\ pending \subseteq PendingW
    /\ net \subseteq PushMsg
    /\ acked \subseteq AckedW
    /\ evictCount \in 0..MaxEvicts

\* Every place a write's identity can exist, normalized to [key, ep, ver,
\* wid]: replica memories, in-flight pushes, the pending buffer, and the
\* history of client acks.
MemRecs  == {[key |-> k, ep |-> mem[r][k].ep, ver |-> mem[r][k].ver,
              wid |-> mem[r][k].wid] :
             <<r, k>> \in {<<rr, kk>> \in Replicas \X Keys :
                           mem[rr][kk] # NoVal}}
PushRecs == {[key |-> m.key, ep |-> m.ep, ver |-> m.ver, wid |-> m.wid] :
             m \in net}
PendRecs == {[key |-> pw.key, ep |-> pw.ep, ver |-> pw.ver,
              wid |-> pw.wid] : pw \in pending}
AckRecs  == {[key |-> w.key, ep |-> w.ep, ver |-> w.ver, wid |-> w.wid] :
             w \in acked}
Universe == MemRecs \cup PushRecs \cup PendRecs \cup AckRecs

\* (1) No silent divergence: a (key, epoch, ver) identity never refers to
\* two different writes.  This is what the collect/announce epoch
\* handshake exists to protect; drop the announce phase and TLC finds a
\* dead incarnation's ghost sharing (ep, ver) with a new write.
EpochVerUnique ==
    \A a, b \in Universe :
        (a.key = b.key /\ a.ep = b.ep /\ a.ver = b.ver) => a.wid = b.wid

\* (2) The honest loss model, checkable: an acked write is dominated by
\* some replica's memory unless an eviction destroyed its last copy.
\* Losing an acked write any other way is a violation.
AckedImpliesHeldUnlessDoomed ==
    \A w \in acked : w.doomed \/ \E r \in Replicas : Holds(r, w)

\* (3) A ready coordinator holds every non-doomed acked write it
\* committed in its own incarnation: commit applies locally before the
\* client is acked, and memory only grows while ready.  The stronger
\* claim -- a recovered coordinator holds ALL non-doomed acked writes --
\* is FALSE, and TLC produced the counterexample: collect snapshots are
\* point-in-time, so a write still in flight to one peer while its other
\* holder is evicted dodges every snapshot and survives only at the peer
\* it later lands on.  Completeness at the recovered coordinator is
\* therefore eventual, restored by gossip; see DESIGN.md sections 6-7.
CoordinatorHoldsOwnCommits ==
    IsReady(Coordinator) =>
        \A w \in acked :
            w.ep = epoch => (w.doomed \/ Holds(Coordinator, w))

\* (4) When the coordinator is ready, every ready peer agrees on the
\* current epoch (the announce phase completed and nothing regressed).
EpochAgreement ==
    IsReady(Coordinator) =>
        \A p \in Peers : status[p] = "ready" => known[p] = epoch

-----------------------------------------------------------------------------
(* Action property: a replica that stays ready never regresses a served
   record -- neither dropping it nor replacing it with an (ep, ver)
   loser.  Eviction makes a replica not-ready, so blanking memory is
   visible only as unavailability, never as stale data. *)

NoServedRegressionStep ==
    \A r \in Replicas, k \in Keys :
        (IsReady(r) /\ status'[r] = "ready" /\ mem[r][k] # NoVal) =>
            /\ mem'[r][k] # NoVal
            /\ ~Wins(mem[r][k], mem'[r][k])

NoServedRegression == [][NoServedRegressionStep]_vars

=============================================================================
