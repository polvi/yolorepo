---------------------------- MODULE webmtp ----------------------------
(***************************************************************************)
(* MTP (Media Transfer Protocol, over the PTP/USB transport) transaction   *)
(* and session state machine as implemented by the initiator in mtp.js.    *)
(*                                                                         *)
(* An initiator (browser, via WebUSB) and a responder (device) exchange    *)
(* containers over a bulk pipe.  Each transaction is Command -> optional   *)
(* Data -> Response, with per-session monotonically increasing             *)
(* transaction IDs (OpenSession resets the counter to 0, matching         *)
(* MtpDevice.openSession()).                                               *)
(*                                                                         *)
(* Session lifecycle: no session -> OpenSession(1) -> session-required    *)
(* ops (GetStorageIDs, GetObjectInfo) -> CloseSession.  GetDeviceInfo is   *)
(* allowed outside a session.  The device may start with a stale open      *)
(* session (devSession = TRUE initially), in which case OpenSession is     *)
(* answered with SessionAlreadyOpen and the initiator recovers by closing  *)
(* and reopening, exactly as openSession() does in mtp.js.                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANT MaxTid  \* Bound on the tid counter; sent tids stay in 0..MaxTid-1.

VARIABLES
  pc,         \* initiator program counter (which command comes next)
  phase,      \* "ready" (may send) or "await" (transaction outstanding)
  nextTid,    \* initiator's tid counter (this.tid in mtp.js)
  gotData,    \* initiator consumed a Data container this transaction
  outCmd,     \* the outstanding command from the initiator's view
  cmdPipe,    \* bulk-out pipe: commands in flight to the device
  respPipe,   \* bulk-in pipe: containers in flight to the initiator
  devSession  \* device-side session state

vars == <<pc, phase, nextTid, gotData, outCmd, cmdPipe, respPipe, devSession>>

NoCmd      == [op |-> "none", tid |-> 0]
SessionOps == {"GetStorageIDs", "GetObjectInfo"}
AllOps     == {"GetDeviceInfo", "OpenSession", "CloseSession"} \cup SessionOps
RCs        == {"OK", "SessionAlreadyOpen", "SessionNotOpen", "none"}
PCs        == {"maybeInfo", "open", "recoverClose", "recoverOpen",
               "getStorage", "getObjInfo", "close", "done", "failed"}

Cmd(o, t)   == [kind |-> "CMD",  op |-> o,      rc |-> "none", tid |-> t]
DataC(t)    == [kind |-> "DATA", op |-> "none", rc |-> "none", tid |-> t]
RespC(r, t) == [kind |-> "RESP", op |-> "none", rc |-> r,      tid |-> t]

Containers ==
  [kind : {"CMD", "DATA", "RESP"}, op : AllOps \cup {"none"},
   rc : RCs, tid : 0..MaxTid]

Init ==
  /\ pc = "maybeInfo"
  /\ phase = "ready"
  /\ nextTid = 0
  /\ gotData = FALSE
  /\ outCmd = NoCmd
  /\ cmdPipe = <<>>
  /\ respPipe = <<>>
  /\ devSession \in BOOLEAN  \* TRUE models a stale session left by a crash

\* Which operation the initiator issues at each program point.
OpFor(p) ==
  CASE p \in {"open", "recoverOpen"}   -> "OpenSession"
    [] p \in {"recoverClose", "close"} -> "CloseSession"
    [] p = "maybeInfo"                 -> "GetDeviceInfo"
    [] p = "getStorage"                -> "GetStorageIDs"
    [] p = "getObjInfo"                -> "GetObjectInfo"

(***************************************************************************)
(* Initiator actions                                                       *)
(***************************************************************************)

\* transaction(): send a command container with tid = this.tid++.
\* openSession() first resets this.tid to 0, so OpenSession always goes
\* out with tid 0 and the first in-session operation with tid 1.
Send ==
  /\ phase = "ready"
  /\ pc \notin {"done", "failed"}
  /\ LET t == IF OpFor(pc) = "OpenSession" THEN 0 ELSE nextTid
     IN /\ cmdPipe' = Append(cmdPipe, Cmd(OpFor(pc), t))
        /\ outCmd' = [op |-> OpFor(pc), tid |-> t]
        /\ nextTid' = t + 1
  /\ phase' = "await"
  /\ gotData' = FALSE
  /\ UNCHANGED <<pc, respPipe, devSession>>

\* GetDeviceInfo before OpenSession is optional in the app flow.
SkipInfo ==
  /\ pc = "maybeInfo"
  /\ phase = "ready"
  /\ pc' = "open"
  /\ UNCHANGED <<phase, nextTid, gotData, outCmd, cmdPipe, respPipe, devSession>>

\* Where the initiator goes after a response with code rc, mirroring
\* openSession()'s SessionAlreadyOpen recovery and expectOk()'s throw
\* on any other non-OK code ("failed" = a thrown Error surfaced to app).
NextPC(p, rc) ==
  CASE p = "maybeInfo"    -> IF rc = "OK" THEN "open"        ELSE "failed"
    [] p = "open"         -> IF rc = "OK" THEN "getStorage"
                             ELSE IF rc = "SessionAlreadyOpen"
                                  THEN "recoverClose" ELSE "failed"
    [] p = "recoverClose" -> IF rc = "OK" THEN "recoverOpen" ELSE "failed"
    [] p = "recoverOpen"  -> IF rc = "OK" THEN "getStorage"  ELSE "failed"
    [] p = "getStorage"   -> IF rc = "OK" THEN "getObjInfo"  ELSE "failed"
    [] p = "getObjInfo"   -> IF rc = "OK" THEN "close"       ELSE "failed"
    [] p = "close"        -> IF rc = "OK" THEN "done"        ELSE "failed"

\* First Data container of a transaction: recorded as the data phase.
RecvData ==
  /\ phase = "await"
  /\ respPipe /= <<>>
  /\ Head(respPipe).kind = "DATA"
  /\ gotData = FALSE
  /\ gotData' = TRUE
  /\ respPipe' = Tail(respPipe)
  /\ UNCHANGED <<pc, phase, nextTid, outCmd, cmdPipe, devSession>>

\* A second Data container: transaction() would throw
\* "expected response container" -- never treat Data as a Response.
RecvUnexpectedData ==
  /\ phase = "await"
  /\ respPipe /= <<>>
  /\ Head(respPipe).kind = "DATA"
  /\ gotData = TRUE
  /\ pc' = "failed"
  /\ phase' = "ready"
  /\ outCmd' = NoCmd
  /\ respPipe' = Tail(respPipe)
  /\ UNCHANGED <<nextTid, gotData, cmdPipe, devSession>>

\* Response container completes the transaction.
RecvResp ==
  /\ phase = "await"
  /\ respPipe /= <<>>
  /\ Head(respPipe).kind = "RESP"
  /\ pc' = NextPC(pc, Head(respPipe).rc)
  /\ phase' = "ready"
  /\ gotData' = FALSE
  /\ outCmd' = NoCmd
  /\ respPipe' = Tail(respPipe)
  /\ UNCHANGED <<nextTid, cmdPipe, devSession>>

(***************************************************************************)
(* Responder (device) action: consume a command, produce optional Data     *)
(* then a Response, echoing the command's transaction ID.                  *)
(***************************************************************************)
DevHandle ==
  /\ cmdPipe /= <<>>
  /\ LET c == Head(cmdPipe) IN
       /\ cmdPipe' = Tail(cmdPipe)
       /\ CASE c.op = "GetDeviceInfo" ->
                \* Allowed outside a session; has a data phase.
                /\ respPipe' = respPipe \o <<DataC(c.tid), RespC("OK", c.tid)>>
                /\ UNCHANGED devSession
            [] c.op = "OpenSession" ->
                IF devSession
                THEN /\ respPipe' = Append(respPipe,
                                           RespC("SessionAlreadyOpen", c.tid))
                     /\ UNCHANGED devSession
                ELSE /\ devSession' = TRUE
                     /\ respPipe' = Append(respPipe, RespC("OK", c.tid))
            [] c.op = "CloseSession" ->
                IF devSession
                THEN /\ devSession' = FALSE
                     /\ respPipe' = Append(respPipe, RespC("OK", c.tid))
                ELSE /\ respPipe' = Append(respPipe,
                                           RespC("SessionNotOpen", c.tid))
                     /\ UNCHANGED devSession
            [] c.op \in SessionOps ->
                IF devSession
                THEN \* Data phase then OK.
                     /\ respPipe' = respPipe \o <<DataC(c.tid),
                                                  RespC("OK", c.tid)>>
                     /\ UNCHANGED devSession
                ELSE \* Reject rather than misbehave: no data phase.
                     /\ respPipe' = Append(respPipe,
                                           RespC("SessionNotOpen", c.tid))
                     /\ UNCHANGED devSession
  /\ UNCHANGED <<pc, phase, nextTid, gotData, outCmd>>

Terminating ==
  /\ pc \in {"done", "failed"}
  /\ UNCHANGED vars

Next ==
  \/ Send
  \/ SkipInfo
  \/ RecvData
  \/ RecvUnexpectedData
  \/ RecvResp
  \/ DevHandle
  \/ Terminating

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
  /\ pc \in PCs
  /\ phase \in {"ready", "await"}
  /\ nextTid \in 0..MaxTid
  /\ gotData \in BOOLEAN
  /\ outCmd \in [op : AllOps \cup {"none"}, tid : 0..MaxTid]
  /\ cmdPipe \in Seq(Containers)
  /\ respPipe \in Seq(Containers)
  /\ devSession \in BOOLEAN

\* The initiator never has to treat an unexpected container as a
\* response, and no operation the initiator issues is rejected: pc
\* "failed" (a thrown Error in mtp.js) is unreachable against a
\* spec-conforming device, including the stale-session start.
NoTransportFailure == pc /= "failed"

\* Every container heading to the initiator carries the transaction ID of
\* the one outstanding command, so completing on FIFO order is sound even
\* though mtp.js never compares c.tid against the command tid.
RespTidMatchesOutstanding ==
  \A i \in 1..Len(respPipe) :
    /\ outCmd /= NoCmd
    /\ respPipe[i].tid = outCmd.tid

\* At most one transaction is outstanding on the pipe at any time.
AtMostOneOutstanding ==
  /\ Len(cmdPipe) <= 1
  /\ Len(respPipe) <= 2
  /\ (phase = "ready") => (cmdPipe = <<>> /\ respPipe = <<>>)
  /\ (phase = "ready") <=> (outCmd = NoCmd)

\* Session-required operations only ever sit on the pipe while the
\* device-side session is open.
SessionOpsOnlyWhenOpen ==
  /\ \A i \in 1..Len(cmdPipe) :
       cmdPipe[i].op \in SessionOps => devSession
  /\ outCmd.op \in SessionOps => devSession

\* Transaction IDs increase monotonically: the outstanding command always
\* carries the newest tid, and the counter only moves forward between
\* OpenSession resets.
TidMonotonic ==
  outCmd /= NoCmd => outCmd.tid = nextTid - 1

\* A transaction sees at most one data phase before its response.
SingleDataPhase ==
  \A i \in 1..Len(respPipe) :
    respPipe[i].kind = "DATA" =>
      /\ ~gotData
      /\ \A j \in 1..Len(respPipe) : j /= i => respPipe[j].kind /= "DATA"

=======================================================================
