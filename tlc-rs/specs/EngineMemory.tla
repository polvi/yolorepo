--------------------------- MODULE EngineMemory ---------------------------
(***************************************************************************)
(* Isolate lifecycle for the tlc-rs wasm engine, which runs in its own     *)
(* dedicated Cloudflare Worker (tlc-engine), reached from the tlc web      *)
(* worker over a service binding.  One engine isolate (one wasm instance)  *)
(* is reused across a sequence of RPC calls, and wasm linear memory only   *)
(* grows, never shrinks.  Two defenses added after a heavy check pinned    *)
(* an isolate near the 128 MiB kill limit and poisoned every later         *)
(* request:                                                               *)
(*                                                                        *)
(*   - The engine polls memory between batches of states and stops a      *)
(*     check gracefully once memory exceeds EngineBudget.  Because it     *)
(*     polls, memory can overshoot the budget by at most one growth       *)
(*     step (MaxGrow) before the stop lands.                              *)
(*   - The engine worker's RPC wrapper (the "shell" below) re-instantiates *)
(*     the wasm instance (memory drops back to InitMem) whenever memory   *)
(*     exceeds ResetThreshold after a call, and on a throw it resets,     *)
(*     retries once on a fresh instance, and resets again before          *)
(*     rethrowing.  A rethrow crosses the service binding as a rejected   *)
(*     promise, which the web worker maps to a resource_limit response;   *)
(*     the reset protocol itself is unchanged by the two-worker split.    *)
(*                                                                        *)
(* Memory is abstract units.  Key invariants: a request never starts on   *)
(* an instance above ResetThreshold (no polluted-isolate observations),   *)
(* and memory never reaches IsolateLimit (the isolate is never killed).   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    InitMem,        \* linear memory of a freshly instantiated engine
    ResetThreshold, \* wrapper resets after a call when mem exceeds this
    EngineBudget,   \* engine stops a check once mem exceeds this
    IsolateLimit,   \* runtime kills the whole isolate at this size
    MaxGrow,        \* max memory growth between two engine polls
    MaxRequests     \* number of requests hitting the isolate (finiteness)

ASSUME /\ InitMem <= ResetThreshold
       /\ ResetThreshold < EngineBudget
       /\ EngineBudget + MaxGrow < IsolateLimit
       /\ MaxGrow >= 1

VARIABLES
    mem,        \* current wasm linear memory, in abstract units
    phase,      \* "idle" (between requests) or "checking" (call in flight)
    retried,    \* current call already threw and was retried once
    reqs        \* requests started so far

vars == <<mem, phase, retried, reqs>>

TypeOK ==
    /\ mem \in 0..IsolateLimit
    /\ phase \in {"idle", "checking"}
    /\ retried \in BOOLEAN
    /\ reqs \in 0..MaxRequests

---------------------------------------------------------------------------

Init ==
    /\ mem = InitMem
    /\ phase = "idle"
    /\ retried = FALSE
    /\ reqs = 0

\* A new request arrives over the service binding, reaches the reused
\* engine-worker isolate, and enters the engine.
StartRequest ==
    /\ phase = "idle"
    /\ reqs < MaxRequests
    /\ phase' = "checking"
    /\ retried' = FALSE
    /\ reqs' = reqs + 1
    /\ UNCHANGED mem

\* The check allocates: memory grows by a nondeterministic bounded amount.
\* The engine keeps running only while its last poll saw mem within the
\* budget, so growth is enabled only when mem <= EngineBudget.
Grow ==
    /\ phase = "checking"
    /\ mem <= EngineBudget
    /\ \E g \in 1..MaxGrow : mem' = mem + g
    /\ UNCHANGED <<phase, retried, reqs>>

\* The RPC wrapper's after-call reset: re-instantiate when memory exceeds
\* the threshold, otherwise keep the (still small) instance.
ShellSettle == IF mem > ResetThreshold THEN InitMem ELSE mem

\* The call returns: either the check completed within budget, or the
\* engine's poll tripped (mem > EngineBudget, StopReason::Memory) and it
\* stopped gracefully with a resource_limit result.  Either way the
\* wrapper's finally-clause reset runs before the isolate goes back to
\* idle, and the result is returned across the service binding.
FinishCall ==
    /\ phase = "checking"
    /\ mem' = ShellSettle
    /\ phase' = "idle"
    /\ UNCHANGED <<retried, reqs>>

\* The engine throws mid-call.  The wrapper resets to a fresh instance and
\* retries the same request once, all inside the engine worker.
ThrowRetry ==
    /\ phase = "checking"
    /\ ~retried
    /\ mem' = InitMem
    /\ retried' = TRUE
    /\ UNCHANGED <<phase, reqs>>

\* The retried call throws too: the wrapper resets again and rethrows; the
\* throw crosses the service binding as a rejected promise, which the web
\* worker maps to a structured resource_limit error.
ThrowFail ==
    /\ phase = "checking"
    /\ retried
    /\ mem' = InitMem
    /\ phase' = "idle"
    /\ UNCHANGED <<retried, reqs>>

Next ==
    \/ StartRequest
    \/ Grow
    \/ FinishCall
    \/ ThrowRetry
    \/ ThrowFail

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Invariants *)

\* A fresh request never observes a polluted instance: whenever the isolate
\* is idle (so any StartRequest happens from here, with mem unchanged),
\* memory is at most the reset threshold.
FreshStart ==
    phase = "idle" => mem <= ResetThreshold

\* The isolate is never killed: memory stays strictly below the limit.
BelowKill ==
    mem < IsolateLimit

\* During a call, memory overshoots the engine budget by at most one
\* growth step between polls.
BoundedOvershoot ==
    mem <= EngineBudget + MaxGrow

(* Action property: memory only ever changes by a bounded growth step or a
   reset to the fresh-instance size (checked as [][...]_vars). *)
GrowOrReset ==
    [][\/ mem' = mem
       \/ mem' = InitMem
       \/ mem' \in (mem + 1)..(mem + MaxGrow)]_vars

===========================================================================
