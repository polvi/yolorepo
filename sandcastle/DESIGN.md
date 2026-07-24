# sandcastle

A key-value store on Cloudflare Workers whose state lives only in process
memory. Nothing is ever written to Durable Object storage, KV, D1, or R2.
The platform evicts isolates whenever it likes, so the data survives only
because a small set of live processes keeps holding it, re-seeding any
process that comes back empty. When every process dies at once, the data is
gone. That is the point: sandcastle exists for the systems challenge of
keeping state alive on a substrate designed to take it away, and loss is a
documented, accepted outcome rather than a failure.

This document is the design. The companion TLA+ spec
(`specs/Handoff.tla`) model-checks the replication and recovery protocol;
sections below cross-reference its actions by name. There is no
implementation yet.

## 1. Platform constraints

The design leans on the following properties of Cloudflare Durable Objects.
Claims marked **verify during build** are believed true but must be
confirmed empirically before the implementation is trusted.

- A DO name maps to at most one live instance at a time, globally. Eviction
  followed by a request produces a fresh instance (empty memory) under the
  same name, which is always addressable. This is the singleton property
  the whole design rests on. (**verify during build**: behavior during
  network partitions inside Cloudflare.)
- Idle DOs are evicted after seconds; deploys evict every instance at
  roughly the same time, so **every deploy is a total death**.
- In-flight HTTP requests outlive their sender: a replication push sent by
  an instance that is then evicted can still be delivered later. The
  protocol must tolerate these ghosts.
- A pending `setTimeout` / unresolved promise keeps a DO resident
  (**verify during build**: exact idle-timeout rules, `waitUntil` lifetime
  inside DOs).
- DO alarms persist a timestamp to storage. Sandcastle refuses them on
  principle (see §3).
- WebSocket hibernation writes attachment state and lets memory be
  reclaimed, so `watch` sockets must be non-hibernating (**verify during
  build**: billing implications).

## 2. Topology

Each namespace is served by three named replica DOs, `r0`, `r1`, `r2`,
derived from the namespace name. `r0` is the fixed coordinator: all writes
go through it. There is no leader election; because DO names are
singletons, "the coordinator is down" is only a cold-start window of
seconds during which writes fail with 503 and the client retries. `r1` and
`r2` are peers: they hold full copies, serve reads, and ack replication.

## 3. Liveness machinery

This layer keeps the replicas resident and is deliberately outside the
spec (the spec treats eviction as an arbitrary environment action).

- Every replica runs an in-memory `setTimeout` heartbeat loop (~2–5s),
  pinging the other two. The traffic keeps all three active; a heartbeat
  answered by a fresh, empty instance is what triggers recovery (§5).
- A stateless cron Worker fires every minute and pings all replicas of
  every known-active namespace. It is the dead-man's switch that restarts
  the heartbeat mesh after a total death or a deploy.
- No DO alarms. An alarm persists a wake-up timestamp to durable storage,
  which violates the memory-only constraint in spirit even though it
  carries no user data. The pragmatic alternative (alarms as pure wake-up
  scheduling) is acknowledged and rejected; the cron Worker covers the
  same need externally.

## 4. Replication protocol

Records and versions. Every stored record is tagged `(epoch, ver, wid)`.
`epoch` identifies the coordinator incarnation that issued the write
(§5), `ver` is a per-incarnation monotonic counter, and `wid` is a
globally unique write id. Records are ordered lexicographically by
`(epoch, ver)`; merge always keeps the winner and never regresses
(spec: `Wins`, `MergeRec`). This is the same trick as Raft terms: a new
incarnation does not need to recover the old counter, because any
`(epoch+1, 1)` beats any `(epoch, n)`.

Write path (spec: `ClientWrite`, `DeliverPush`, `DeliverAck`,
`CommitWrite`):

1. The coordinator, when ready, assigns `(epoch, verCtr+1, wid)` to an
   incoming `PUT`, buffers it as pending, and pushes it to both peers.
2. A peer receiving a push merges it into memory (max-merge, so late and
   duplicate deliveries are harmless) and acks the `wid`. Peers accept
   pushes even while recovering; a merged push is genuinely held.
3. On the first peer ack the write is quorum-held (coordinator + one
   peer = 2 of 3): the coordinator applies it to its own memory, acks the
   client, and drops it from pending.
4. Anti-entropy gossip (spec: `Gossip`) piggybacks on heartbeats and
   max-merges full state between ready replicas, closing the gap to the
   third copy.

Serving rules: replicas serve only what is in their memory, and only while
ready; the coordinator's pending buffer is never served, so eviction wipes
it without breaking any promise (the client just times out and retries).
Peers may therefore serve a not-yet-committed write; that is ordinary
read-uncommitted behavior for an unacked write, which may or may not
survive.

Ghost pushes need no fencing. A push from a dead incarnation that lands
late is either a record the current state already dominates (merge drops
it) or a genuine write from this lineage's history arriving late (merge
applies it). Epoch tags make both cases safe; the spec's core invariant
`EpochVerUnique` checks that no two distinct writes ever share a
`(key, epoch, ver)` identity.

## 5. Recovery

A replica that boots empty must rebuild before serving.

Peer recovery (spec: `ReseedPeer`, `FinishRecoveryPeer`): merge atomic
snapshots from **all** other replicas (empty snapshots count), then become
ready. Single-source reseed is unsound; see §6.

Coordinator recovery is two-phase, because the coordinator must also choose
its next epoch (spec: `ReseedC`, `ChooseEpoch`, `AnnounceTo`,
`FinishRecoveryC`):

1. **Collect**: merge snapshots from both peers; each snapshot response
   also reports the highest epoch that peer has heard of (`known`).
2. **Choose**: `epoch := max(everything collected) + 1`.
3. **Announce**: install the new epoch at both peers before serving a
   single write. Only then is the coordinator ready, with `verCtr = 0`.

The announce phase is what makes epoch choice safe, and it is load-bearing
in exactly the way a Paxos prepare round is: an incarnation may issue
writes only after every peer knows its epoch, so any later recovery is
guaranteed to collect that epoch from someone (evicting all witnesses
first would require evicting every replica, which is total death). An
incarnation that dies before completing announce never wrote anything, so
its epoch number may be harmlessly reused. Dropping the announce phase is
falsifiable: the model checker finds two incarnations issuing different
writes under the same `(epoch, ver)` (see §7).

In reality `known` is carried on heartbeats and snapshot responses; in the
spec it is the `known[p]` variable.

## 6. Loss model

The honest guarantee: **an acked write is lost only if every replica
holding it is evicted before propagating it onward.** At ack time that is
at least two replicas (coordinator + acking peer), and gossip widens it to
three. The limiting case is total death, and every deploy is a total
death.

What the spec proves (within its finite bounds), as invariants over
`Handoff.tla`:

- `EpochVerUnique` — no silent divergence: a `(key, epoch, ver)` identity
  never refers to two different writes, across all memories, pending
  buffers, in-flight messages, and the ack history.
- `AckedImpliesHeldUnlessDoomed` — an acked write is always dominated by
  some replica's memory unless an eviction destroyed its last copy
  (`doomed`, stamped by the `Evict` action at the moment it happens). Any
  other way of losing an acked write is a checker violation.
- `CoordinatorHoldsOwnCommits` — a ready coordinator holds every
  non-doomed acked write of its own incarnation. The stronger claim, that
  a *recovered* coordinator holds every acked write, is false; the
  checker produced the counterexample (§7, finding 3). Completeness at
  the coordinator is eventual, restored by gossip.
- `EpochAgreement` — when the coordinator is ready, every ready peer
  agrees on the current epoch.
- `NoServedRegression` (action property) — a replica that stays ready
  never regresses a served record.

Passing configuration (saved as `specs/Handoff.cfg`): 3 replicas, 1 key,
2 writes, 2 evictions; 488,873 states generated, 95,028 distinct, search
depth 23, fully exhausted.

What the spec does not cover: the liveness machinery (§3), timing, and
total death. The model constrains eviction so that some replica is always
ready (spec: guard on `Evict`), scoping the theorems to the
non-total-death regime where the guarantees actually apply. The
replication ack channel is abstracted: `CommitWrite` is enabled exactly
when a peer's memory holds the pushed record, which is what an ack
witnesses; the racy interleavings this drops converge to the same states.

Total death in reality: the cron Worker resurrects the ring, the new
coordinator's collect phase finds nothing, and it mints a fresh random
**lineage id**. All records and epochs are scoped to a lineage; a ghost
push from a previous lineage is rejected by lineage mismatch rather than
compared (epochs from different lineages are not ordered, since without
storage there is nothing to order them by). Clients see the lineage id in
every response and must treat version comparisons across lineages as
meaningless. The lineage mechanics deserve their own small spec in the
build phase (`Lineage.tla`, open question in §8).

Read staleness: peers are bounded-stale by the gossip interval, and a
freshly recovered coordinator can briefly miss acked writes that survive
elsewhere (§7, finding 3). A `?quorum` read flag (read coordinator + one
peer, take the max) narrows the window but cannot close it: evictions can
degrade an acked write to a single surviving copy, which only a
read-all-three would be guaranteed to see. Read-your-writes is therefore
best-effort across coordinator failovers, exact within a coordinator
incarnation.

## 7. What model checking caught

Two deliberate falsification runs plus one genuine surprise, kept as
evidence that the invariants have teeth (1 and 2 ran against variant
specs; 3 was found in the intended protocol):

1. **Single-peer reseed** (`ChooseEpoch` enabled after collecting only one
   peer): the checker produces a 10-step trace where an acked write held
   only by the un-consulted peer is missing from the ready coordinator.
2. **No announce phase** (`ChooseEpoch` goes straight to ready): the
   checker produces a trace where an incarnation chooses an epoch, writes,
   and dies before any peer or record witnesses the epoch; the next
   incarnation re-chooses the same epoch and issues a different write
   under the same `(epoch, ver)` — `EpochVerUnique` violated. This is why
   the announce phase is load-bearing.
3. **Collect snapshots race in-flight deliveries** (found in the real
   protocol, 13-step trace): a write is acked while its push to `r2` is
   still in flight; the coordinator is evicted and snapshots `r2` before
   the push lands, the other holder `r1` is evicted, and the coordinator
   then snapshots the now-empty `r1`. Every peer was consulted, yet the
   acked write survives only at `r2` and the recovered coordinator serves
   without it. No finite number of collect rounds fixes this, since
   deliveries can be delayed arbitrarily. The design consequence:
   "recovered coordinator holds all acked writes" was demoted from a
   safety claim to an eventual one (gossip restores it), the spec
   invariant was weakened to `CoordinatorHoldsOwnCommits`, and the
   read-your-writes caveat in §6 exists because of this trace.

## 8. API sketch (out of spec scope)

```
PUT    /ns/:ns/kv/:key          body = value; 200 ⇒ quorum-held
GET    /ns/:ns/kv/:key          any ready replica; ?quorum for RYW
DELETE /ns/:ns/kv/:key          tombstone write (a normal versioned write)
GET    /ns/:ns                  list keys
GET    /ns/:ns/watch            WebSocket, non-hibernating, change feed
```

Every response carries `x-sandcastle-lineage`, `x-sandcastle-version`
(`epoch.ver`), and the replica that served it. Hono router in front,
replica DOs behind. Marketing/product split per playground convention,
future home sandcastle.proc.io.

## 9. Open build-phase questions

- Does a pending `setTimeout` reliably prevent idle eviction, and what is
  the actual idle timeout for DOs without hibernatable WebSockets?
- `waitUntil` lifetime semantics inside DOs.
- Are deploys gradual enough that any replica survives a version rollout?
  (Assume no.)
- Tombstone garbage collection: tombstones must outlive the gossip
  interval; in a memory-only store they can simply live until total death,
  but memory pressure may want a horizon.
- Value size and namespace count limits; per-namespace memory budget.
- `Lineage.tla`: model total death, lineage minting, and cross-lineage
  ghost rejection.
- Heartbeat/gossip transport: plain fetch vs a WebSocket mesh between the
  three replicas.
