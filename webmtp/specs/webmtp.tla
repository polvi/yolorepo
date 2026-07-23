---------------------------- MODULE webmtp ----------------------------
(***************************************************************************)
(* MTP (Media Transfer Protocol, over the PTP/USB transport) transaction   *)
(* and session state machine as implemented by the initiator in mtp.ts.    *)
(*                                                                         *)
(* An initiator (browser, via WebUSB) and a responder (device) exchange    *)
(* containers over a pair of bulk pipes.  Each transaction is              *)
(* Command -> optional Data -> Response, where the data phase runs in one  *)
(* direction chosen by the operation: responder->initiator for reads       *)
(* (GetDeviceInfo, GetStorageIDs), initiator->responder for writes         *)
(* (SendObjectInfo, SendObject, via transaction()'s dataOut argument), and *)
(* absent for DeleteObject and the session operations.                     *)
(*                                                                         *)
(* Transaction IDs increase per session (OpenSession resets the counter    *)
(* to 0, matching MtpDevice.openSession()), and transaction() rejects a    *)
(* RESPONSE container whose tid differs from the command's tid             *)
(* (RecvRespBadTid, a thrown Error); NoTransportFailure shows this path    *)
(* is unreachable against a conforming responder.                          *)
(*                                                                         *)
(* Session lifecycle: no session -> OpenSession(1) -> session-required     *)
(* ops -> CloseSession.  GetDeviceInfo is allowed outside a session.  The  *)
(* device may start with a stale open session (devSession = TRUE           *)
(* initially), answered with SessionAlreadyOpen; the initiator recovers by *)
(* closing and reopening, exactly as openSession() does in mtp.ts.         *)
(*                                                                         *)
(* SendObjectInfo comes in two flavors distinguished by the ObjectInfo     *)
(* dataset's format code:                                                  *)
(*   - file-flavored (sendObject() in mtp.ts): announces incoming bytes;   *)
(*     SendObject must follow immediately, and the responder holds the     *)
(*     ObjectInfo as pending until it does.                                *)
(*   - folder-flavored (createFolder() in mtp.ts, format = Association):   *)
(*     a complete, terminal operation on its own.  No SendObject follows,  *)
(*     and it clears any notion of pending file info on the responder.     *)
(* SendObject without an immediately preceding successful file-flavored    *)
(* SendObjectInfo is answered NoValidObjectInfo; the initiator never       *)
(* issues that sequence.                                                   *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANT MaxTid  \* Bound on the tid counter; sent tids stay in 0..MaxTid-1.

VARIABLES
  pc,          \* initiator program counter (which command comes next)
  phase,       \* "ready" (may send) or "await" (transaction outstanding)
  nextTid,     \* initiator's tid counter (this.tid in mtp.ts)
  gotData,     \* initiator consumed a Data container this transaction
  objInfoDone, \* initiator: file SendObjectInfo succeeded, SendObject may follow
  outCmd,      \* the outstanding command from the initiator's view
  cmdPipe,     \* bulk-out pipe: commands and I->R data heading to the device
  respPipe,    \* bulk-in pipe: containers heading to the initiator
  devSession,  \* responder-side session state
  devObjInfo   \* responder holds a valid FILE ObjectInfo awaiting SendObject

vars == <<pc, phase, nextTid, gotData, objInfoDone, outCmd,
          cmdPipe, respPipe, devSession, devObjInfo>>

NoCmd      == [op |-> "none", tid |-> 0]
DataInOps  == {"GetDeviceInfo", "GetStorageIDs"}    \* responder -> initiator
\* Initiator -> responder data phase.  Both SendObjectInfo flavors carry an
\* ObjectInfo dataset; SendObject carries the object bytes.
DataOutOps == {"SendObjectInfoFile", "SendObjectInfoFolder", "SendObject"}
SessionOps == {"GetStorageIDs", "SendObjectInfoFile", "SendObjectInfoFolder",
               "SendObject", "DeleteObject"}
AllOps     == {"GetDeviceInfo", "OpenSession", "CloseSession"} \cup SessionOps
RCs        == {"OK", "SessionAlreadyOpen", "SessionNotOpen",
               "NoValidObjectInfo", "none"}
PCs        == {"maybeInfo", "open", "recoverClose", "recoverOpen",
               "getStorage", "mkFolder", "sendObjInfo", "sendObj", "delete",
               "close", "done", "failed"}

Cmd(o, t)     == [kind |-> "CMD",  op |-> o,      rc |-> "none", tid |-> t]
DataOutC(o,t) == [kind |-> "DATA", op |-> o,      rc |-> "none", tid |-> t]
DataC(t)      == [kind |-> "DATA", op |-> "none", rc |-> "none", tid |-> t]
RespC(r, t)   == [kind |-> "RESP", op |-> "none", rc |-> r,      tid |-> t]

Containers ==
  [kind : {"CMD", "DATA", "RESP"}, op : AllOps \cup {"none"},
   rc : RCs, tid : 0..MaxTid]

Init ==
  /\ pc = "maybeInfo"
  /\ phase = "ready"
  /\ nextTid = 0
  /\ gotData = FALSE
  /\ objInfoDone = FALSE
  /\ outCmd = NoCmd
  /\ cmdPipe = <<>>
  /\ respPipe = <<>>
  /\ devSession \in BOOLEAN  \* TRUE models a stale session left by a crash
  /\ devObjInfo = FALSE

\* Which operation the initiator issues at each program point: the app flow
\* GetDeviceInfo? -> OpenSession -> GetStorageIDs -> createFolder() (a
\* standalone folder-flavored SendObjectInfo) -> sendObject() (file-flavored
\* SendObjectInfo then SendObject) -> DeleteObject -> CloseSession.
OpFor(p) ==
  CASE p \in {"open", "recoverOpen"}   -> "OpenSession"
    [] p \in {"recoverClose", "close"} -> "CloseSession"
    [] p = "maybeInfo"                 -> "GetDeviceInfo"
    [] p = "getStorage"                -> "GetStorageIDs"
    [] p = "mkFolder"                  -> "SendObjectInfoFolder"
    [] p = "sendObjInfo"               -> "SendObjectInfoFile"
    [] p = "sendObj"                   -> "SendObject"
    [] p = "delete"                    -> "DeleteObject"

(***************************************************************************)
(* Initiator actions                                                       *)
(***************************************************************************)

\* transaction(): send a command container with tid = this.tid++, followed
\* immediately by an I->R DATA container when the operation carries dataOut
\* (either SendObjectInfo flavor's ObjectInfo dataset, SendObject's bytes).
\* openSession() first resets this.tid to 0, so OpenSession goes out with
\* tid 0.
Send ==
  /\ phase = "ready"
  /\ pc \notin {"done", "failed"}
  /\ LET o == OpFor(pc)
         t == IF o = "OpenSession" THEN 0 ELSE nextTid
     IN /\ cmdPipe' = IF o \in DataOutOps
                      THEN cmdPipe \o <<Cmd(o, t), DataOutC(o, t)>>
                      ELSE Append(cmdPipe, Cmd(o, t))
        /\ outCmd' = [op |-> o, tid |-> t]
        /\ nextTid' = t + 1
  /\ phase' = "await"
  /\ gotData' = FALSE
  /\ UNCHANGED <<pc, objInfoDone, respPipe, devSession, devObjInfo>>

\* GetDeviceInfo before OpenSession is optional in the app flow.
SkipInfo ==
  /\ pc = "maybeInfo"
  /\ phase = "ready"
  /\ pc' = "open"
  /\ UNCHANGED <<phase, nextTid, gotData, objInfoDone, outCmd,
                 cmdPipe, respPipe, devSession, devObjInfo>>

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
    [] p = "getStorage"   -> IF rc = "OK" THEN "mkFolder"    ELSE "failed"
    [] p = "mkFolder"     -> IF rc = "OK" THEN "sendObjInfo" ELSE "failed"
    [] p = "sendObjInfo"  -> IF rc = "OK" THEN "sendObj"     ELSE "failed"
    [] p = "sendObj"      -> IF rc = "OK" THEN "delete"      ELSE "failed"
    [] p = "delete"       -> IF rc = "OK" THEN "close"       ELSE "failed"
    [] p = "close"        -> IF rc = "OK" THEN "done"        ELSE "failed"

\* First R->I Data container of a transaction: recorded as the data phase.
RecvData ==
  /\ phase = "await"
  /\ respPipe /= <<>>
  /\ Head(respPipe).kind = "DATA"
  /\ gotData = FALSE
  /\ gotData' = TRUE
  /\ respPipe' = Tail(respPipe)
  /\ UNCHANGED <<pc, phase, nextTid, objInfoDone, outCmd,
                 cmdPipe, devSession, devObjInfo>>

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
  /\ UNCHANGED <<nextTid, gotData, objInfoDone, cmdPipe, devSession, devObjInfo>>

\* Response container with the matching tid completes the transaction.
\* A successful FILE SendObjectInfo arms the SendObject that must follow.
\* A folder SendObjectInfo is terminal: it never arms SendObject, and it
\* clears any stale pairing state.  Anything else that finishes the pair
\* (or the session boundary) clears the pairing on the initiator side.
RecvResp ==
  /\ phase = "await"
  /\ respPipe /= <<>>
  /\ Head(respPipe).kind = "RESP"
  /\ Head(respPipe).tid = outCmd.tid
  /\ pc' = NextPC(pc, Head(respPipe).rc)
  /\ objInfoDone' = IF outCmd.op = "SendObjectInfoFile"
                       /\ Head(respPipe).rc = "OK"
                    THEN TRUE
                    ELSE IF outCmd.op \in {"SendObjectInfoFile",
                                           "SendObjectInfoFolder",
                                           "SendObject", "OpenSession",
                                           "CloseSession"}
                    THEN FALSE
                    ELSE objInfoDone
  /\ phase' = "ready"
  /\ gotData' = FALSE
  /\ outCmd' = NoCmd
  /\ respPipe' = Tail(respPipe)
  /\ UNCHANGED <<nextTid, cmdPipe, devSession, devObjInfo>>

\* transaction() compares the RESPONSE container's tid against the
\* command's tid and throws on mismatch (stale container on the pipe)
\* instead of accepting the response.  Against a conforming responder this
\* action is never enabled -- NoTransportFailure proves it.
RecvRespBadTid ==
  /\ phase = "await"
  /\ respPipe /= <<>>
  /\ Head(respPipe).kind = "RESP"
  /\ Head(respPipe).tid /= outCmd.tid
  /\ pc' = "failed"
  /\ phase' = "ready"
  /\ gotData' = FALSE
  /\ outCmd' = NoCmd
  /\ respPipe' = Tail(respPipe)
  /\ UNCHANGED <<nextTid, objInfoDone, cmdPipe, devSession, devObjInfo>>

(***************************************************************************)
(* Responder (device) action: consume a command (plus its I->R data phase  *)
(* when the operation has one), produce optional R->I Data then a          *)
(* Response, echoing the command's transaction ID.  A successful FILE      *)
(* SendObjectInfo leaves the responder holding a valid ObjectInfo; a       *)
(* folder SendObjectInfo completes immediately and clears it; any other    *)
(* operation clears it, and SendObject without it is answered with         *)
(* NoValidObjectInfo.                                                      *)
(***************************************************************************)
DevHandle ==
  /\ cmdPipe /= <<>>
  /\ Head(cmdPipe).kind = "CMD"
  /\ LET c == Head(cmdPipe) IN
       /\ IF c.op \in DataOutOps
          THEN \* Drain the I->R data phase along with the command.
               /\ Len(cmdPipe) >= 2
               /\ cmdPipe[2].kind = "DATA"
               /\ cmdPipe[2].tid = c.tid
               /\ cmdPipe' = SubSeq(cmdPipe, 3, Len(cmdPipe))
          ELSE cmdPipe' = Tail(cmdPipe)
       /\ CASE c.op = "GetDeviceInfo" ->
                \* Allowed outside a session; R->I data phase.
                /\ respPipe' = respPipe \o <<DataC(c.tid), RespC("OK", c.tid)>>
                /\ devObjInfo' = FALSE
                /\ UNCHANGED devSession
            [] c.op = "OpenSession" ->
                /\ devObjInfo' = FALSE
                /\ IF devSession
                   THEN /\ respPipe' = Append(respPipe,
                                              RespC("SessionAlreadyOpen", c.tid))
                        /\ UNCHANGED devSession
                   ELSE /\ devSession' = TRUE
                        /\ respPipe' = Append(respPipe, RespC("OK", c.tid))
            [] c.op = "CloseSession" ->
                /\ devObjInfo' = FALSE
                /\ IF devSession
                   THEN /\ devSession' = FALSE
                        /\ respPipe' = Append(respPipe, RespC("OK", c.tid))
                   ELSE /\ respPipe' = Append(respPipe,
                                              RespC("SessionNotOpen", c.tid))
                        /\ UNCHANGED devSession
            [] c.op = "GetStorageIDs" ->
                /\ devObjInfo' = FALSE
                /\ respPipe' = IF devSession
                               THEN respPipe \o <<DataC(c.tid),
                                                  RespC("OK", c.tid)>>
                               ELSE Append(respPipe,
                                           RespC("SessionNotOpen", c.tid))
                /\ UNCHANGED devSession
            [] c.op = "SendObjectInfoFile" ->
                \* I->R data phase already drained above; on success the
                \* responder now expects SendObject next.
                /\ IF devSession
                   THEN /\ devObjInfo' = TRUE
                        /\ respPipe' = Append(respPipe, RespC("OK", c.tid))
                   ELSE /\ devObjInfo' = FALSE
                        /\ respPipe' = Append(respPipe,
                                              RespC("SessionNotOpen", c.tid))
                /\ UNCHANGED devSession
            [] c.op = "SendObjectInfoFolder" ->
                \* Association format: the object (folder) is complete with
                \* this transaction alone.  No pending file info is set --
                \* and any previously pending file info is invalidated.
                /\ devObjInfo' = FALSE
                /\ respPipe' = IF devSession
                               THEN Append(respPipe, RespC("OK", c.tid))
                               ELSE Append(respPipe,
                                           RespC("SessionNotOpen", c.tid))
                /\ UNCHANGED devSession
            [] c.op = "SendObject" ->
                /\ devObjInfo' = FALSE  \* consumed (or rejected) either way
                /\ respPipe' = IF ~devSession
                               THEN Append(respPipe,
                                           RespC("SessionNotOpen", c.tid))
                               ELSE IF devObjInfo
                               THEN Append(respPipe, RespC("OK", c.tid))
                               ELSE Append(respPipe,
                                           RespC("NoValidObjectInfo", c.tid))
                /\ UNCHANGED devSession
            [] c.op = "DeleteObject" ->
                /\ devObjInfo' = FALSE
                /\ respPipe' = IF devSession
                               THEN Append(respPipe, RespC("OK", c.tid))
                               ELSE Append(respPipe,
                                           RespC("SessionNotOpen", c.tid))
                /\ UNCHANGED devSession
  /\ UNCHANGED <<pc, phase, nextTid, gotData, objInfoDone, outCmd>>

Terminating ==
  /\ pc \in {"done", "failed"}
  /\ UNCHANGED vars

Next ==
  \/ Send
  \/ SkipInfo
  \/ RecvData
  \/ RecvUnexpectedData
  \/ RecvResp
  \/ RecvRespBadTid
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
  /\ objInfoDone \in BOOLEAN
  /\ outCmd \in [op : AllOps \cup {"none"}, tid : 0..MaxTid]
  /\ cmdPipe \in Seq(Containers)
  /\ respPipe \in Seq(Containers)
  /\ devSession \in BOOLEAN
  /\ devObjInfo \in BOOLEAN

\* The initiator never has to treat an unexpected container as a
\* response, no operation it issues is rejected, and the tid check in
\* transaction() never fires: pc "failed" (a thrown Error in mtp.ts) is
\* unreachable against a spec-conforming device, including the
\* stale-session start.  In particular NoValidObjectInfo is unreachable:
\* the standalone folder SendObjectInfo never leads the initiator into an
\* unpaired SendObject.
NoTransportFailure == pc /= "failed"

\* Every container heading to the initiator carries the transaction ID of
\* the one outstanding command, so transaction()'s tid check accepts
\* exactly the response it is waiting for.
RespTidMatchesOutstanding ==
  \A i \in 1..Len(respPipe) :
    /\ outCmd /= NoCmd
    /\ respPipe[i].tid = outCmd.tid

\* At most one transaction is outstanding on the pipes at any time
\* (command plus at most one I->R data container outbound, data plus
\* response inbound).
AtMostOneOutstanding ==
  /\ Len(cmdPipe) <= 2
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

\* The data phase runs in the direction the operation dictates: R->I data
\* only for read operations, I->R data only for write operations, and an
\* I->R data container always trails its own command on the bulk-out pipe.
DataDirectionOK ==
  /\ \A i \in 1..Len(respPipe) :
       respPipe[i].kind = "DATA" => outCmd.op \in DataInOps
  /\ \A i \in 1..Len(cmdPipe) :
       cmdPipe[i].kind = "DATA" =>
         /\ cmdPipe[i].op \in DataOutOps
         /\ i > 1
         /\ cmdPipe[i-1].kind = "CMD"
         /\ cmdPipe[i-1].op = cmdPipe[i].op
         /\ cmdPipe[i-1].tid = cmdPipe[i].tid

\* Pairing: the initiator never issues SendObject without a successful
\* FILE-flavored SendObjectInfo as the immediately preceding operation,
\* and whenever SendObject is in flight the responder is still holding
\* that valid file ObjectInfo (no operation slipped in between), so
\* NoValidObjectInfo is unreachable.
SendObjectPaired ==
  /\ outCmd.op = "SendObject" => objInfoDone
  /\ \A i \in 1..Len(cmdPipe) :
       cmdPipe[i].op = "SendObject" => (objInfoDone /\ devObjInfo)

\* A folder-flavored SendObjectInfo is terminal: right after createFolder()
\* completes (pc has advanced past mkFolder with the transaction drained),
\* neither side holds pending file object info -- the folder flavor never
\* arms a SendObject.
FolderInfoNeverArms ==
  /\ (pc = "sendObjInfo" /\ phase = "ready") =>
       (~objInfoDone /\ ~devObjInfo)
  /\ outCmd.op = "SendObjectInfoFolder" => ~objInfoDone

=======================================================================
