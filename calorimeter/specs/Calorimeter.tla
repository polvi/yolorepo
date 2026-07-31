---------------------------- MODULE Calorimeter ----------------------------
(***************************************************************************)
(* Safety spec for an energy-measurement protocol: a power sampler emits  *)
(* timestamped samples (max gap INTERVAL, with jitter); a runner          *)
(* sequentially records an idle-baseline window, then per model           *)
(* [warmup, settle, measured-generation window], then stops the sampler. *)
(* Energy for a window integrates only samples inside the CLOSED          *)
(* interval [t0, t1]; fewer than 2 samples yields no energy estimate.     *)
(*                                                                         *)
(* FINDINGS (caught by TLC):                                              *)
(* 1. "Every generation window contains >= 2 samples" is FALSE for        *)
(*    windows short relative to INTERVAL: a fast generation finishing     *)
(*    inside ~one sampling interval yields a silent zero-energy result.   *)
(* 2. The first guarded fix, "length >= 2*INTERVAL - 1 => 2 samples",     *)
(*    ALSO failed: window boundaries are read by the runner and race      *)
(*    with sample arrival, so a sample due exactly at a boundary can      *)
(*    land just outside.  The tight guarantee is one interval wider:      *)
(*        window length >= 2*INTERVAL  =>  >= 2 samples inside.           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS MAX_TIME, INTERVAL, NUM_MODELS, BASELINE_LEN, WARMUP_LEN, SETTLE_LEN, GEN_MIN, GEN_MAX

ASSUME
  /\ INTERVAL >= 1
  /\ NUM_MODELS >= 1
  /\ BASELINE_LEN >= 1 /\ WARMUP_LEN >= 1 /\ SETTLE_LEN >= 1
  /\ 1 <= GEN_MIN /\ GEN_MIN <= GEN_MAX

VARIABLES now, samplerOn, startT, stopT, lastSample, samples, phase, phaseStart, modelsDone, windows

vars == <<now, samplerOn, startT, stopT, lastSample, samples, phase, phaseStart, modelsDone, windows>>

Phases == {"init", "starting", "baseline", "warmup", "settle", "gen", "stopping", "stopped"}
Kinds  == {"baseline", "warmup", "settle", "gen"}

TypeOK ==
  /\ now \in 0..MAX_TIME
  /\ samplerOn \in BOOLEAN
  /\ startT \in 0..MAX_TIME
  /\ stopT \in 0..(MAX_TIME + 1)
  /\ lastSample \in 0..MAX_TIME
  /\ samples \subseteq 0..MAX_TIME
  /\ phase \in Phases
  /\ phaseStart \in 0..MAX_TIME
  /\ modelsDone \in 0..NUM_MODELS
  /\ windows \subseteq [kind: Kinds, lo: 0..MAX_TIME, hi: 0..MAX_TIME]

Init ==
  /\ now = 0 /\ samplerOn = FALSE
  /\ startT = 0 /\ stopT = MAX_TIME + 1
  /\ lastSample = 0 /\ samples = {}
  /\ phase = "init" /\ phaseStart = 0
  /\ modelsDone = 0 /\ windows = {}

\* Spawn the sampler; the first sample is due within INTERVAL of start.
StartSampler ==
  /\ phase = "init"
  /\ samplerOn' = TRUE
  /\ startT' = now
  /\ lastSample' = now
  /\ phase' = "starting"
  /\ UNCHANGED <<now, stopT, samples, phaseStart, modelsDone, windows>>

\* The runner blocks until the first sample exists, then opens baseline.
BeginBaseline ==
  /\ phase = "starting"
  /\ samples # {}
  /\ phase' = "baseline"
  /\ phaseStart' = now
  /\ UNCHANGED <<now, samplerOn, startT, stopT, lastSample, samples, modelsDone, windows>>

EndBaseline ==
  /\ phase = "baseline"
  /\ now - phaseStart = BASELINE_LEN
  /\ windows' = windows \union {[kind |-> "baseline", lo |-> phaseStart, hi |-> now]}
  /\ phase' = "warmup"
  /\ phaseStart' = now
  /\ UNCHANGED <<now, samplerOn, startT, stopT, lastSample, samples, modelsDone>>

EndWarmup ==
  /\ phase = "warmup"
  /\ now - phaseStart = WARMUP_LEN
  /\ windows' = windows \union {[kind |-> "warmup", lo |-> phaseStart, hi |-> now]}
  /\ phase' = "settle"
  /\ phaseStart' = now
  /\ UNCHANGED <<now, samplerOn, startT, stopT, lastSample, samples, modelsDone>>

EndSettle ==
  /\ phase = "settle"
  /\ now - phaseStart = SETTLE_LEN
  /\ windows' = windows \union {[kind |-> "settle", lo |-> phaseStart, hi |-> now]}
  /\ phase' = "gen"
  /\ phaseStart' = now
  /\ UNCHANGED <<now, samplerOn, startT, stopT, lastSample, samples, modelsDone>>

\* Generation ends nondeterministically in [GEN_MIN, GEN_MAX]: a fast
\* model produces a short measured window.
EndGen ==
  /\ phase = "gen"
  /\ now - phaseStart >= GEN_MIN
  /\ now - phaseStart <= GEN_MAX
  /\ windows' = windows \union {[kind |-> "gen", lo |-> phaseStart, hi |-> now]}
  /\ modelsDone' = modelsDone + 1
  /\ phase' = IF modelsDone + 1 < NUM_MODELS THEN "warmup" ELSE "stopping"
  /\ phaseStart' = now
  /\ UNCHANGED <<now, samplerOn, startT, stopT, lastSample, samples>>

StopSampler ==
  /\ phase = "stopping"
  /\ samplerOn' = FALSE
  /\ stopT' = now
  /\ phase' = "stopped"
  /\ UNCHANGED <<now, startT, lastSample, samples, phaseStart, modelsDone, windows>>

\* A sample block completes now (jitter: any gap in 1..INTERVAL; the
\* upper bound is enforced by the Tick guard).
Emit ==
  /\ samplerOn
  /\ now > lastSample
  /\ samples' = samples \union {now}
  /\ lastSample' = now
  /\ UNCHANGED <<now, samplerOn, startT, stopT, phase, phaseStart, modelsDone, windows>>

\* Runner steps take no model time; they fire before time advances.
Urgent ==
  \/ phase = "init"
  \/ (phase = "starting" /\ samples # {})
  \/ (phase = "baseline" /\ now - phaseStart = BASELINE_LEN)
  \/ (phase = "warmup"   /\ now - phaseStart = WARMUP_LEN)
  \/ (phase = "settle"   /\ now - phaseStart = SETTLE_LEN)
  \/ (phase = "gen"      /\ now - phaseStart = GEN_MAX)
  \/ phase = "stopping"

Tick ==
  /\ now < MAX_TIME
  /\ ~Urgent
  /\ samplerOn => (now + 1) - lastSample <= INTERVAL
  /\ now' = now + 1
  /\ UNCHANGED <<samplerOn, startT, stopT, lastSample, samples, phase, phaseStart, modelsDone, windows>>

Next ==
  \/ StartSampler \/ BeginBaseline
  \/ EndBaseline \/ EndWarmup \/ EndSettle \/ EndGen
  \/ StopSampler
  \/ Emit
  \/ Tick

Spec == Init /\ [][Next]_vars

Measured == {w \in windows : w.kind \in {"baseline", "gen"}}
GenWins  == {w \in windows : w.kind = "gen"}

SamplesIn(lo, hi) == {t \in samples : lo <= t /\ t <= hi}

\* Measurement windows (baseline and per-model generation) are pairwise
\* disjoint as closed intervals: no sample is attributed twice.
MeasuredDisjoint ==
  \A w1, w2 \in Measured :
    w1 # w2 => (w1.hi < w2.lo \/ w2.hi < w1.lo)

\* Every measured window lies inside the sampler-active period.
InSamplerPeriod ==
  \A w \in Measured :
    /\ startT <= w.lo
    /\ w.hi <= (IF phase = "stopped" THEN stopT ELSE now)
    /\ windows # {} => (samplerOn \/ phase = "stopped")

\* Attribution: no generation window overlaps the interior of a warmup
\* or settle period (adjacent phases may share an endpoint instant).
GenClearOfWarmupSettle ==
  \A g \in GenWins :
    \A p \in {w \in windows : w.kind \in {"warmup", "settle"}} :
      p.hi <= g.lo \/ g.hi <= p.lo

\* The baseline window always contains a sample, because the runner
\* waits for the first sample before opening it.
BaselineHasSample ==
  \A w \in {x \in windows : x.kind = "baseline"} :
    SamplesIn(w.lo, w.hi) # {}

\* NAIVE claim -- VIOLATED for short windows, see FINDING 1.  Left
\* defined (unchecked) as documentation.
GenTwoSamplesNaive ==
  \A g \in GenWins : Cardinality(SamplesIn(g.lo, g.hi)) >= 2

\* First guarded fix -- ALSO VIOLATED, see FINDING 2: window boundaries
\* race with sample arrival, so a sample due exactly at t0 or t1 can
\* fall outside the window.  Left defined (unchecked).
GenTwoSamplesOffByOne ==
  \A g \in GenWins :
    (g.hi - g.lo >= 2 * INTERVAL - 1) =>
      Cardinality(SamplesIn(g.lo, g.hi)) >= 2

\* Corrected guarantee: a generation window at least 2*INTERVAL long
\* always contains >= 2 samples, so energy can be integrated.  The
\* bound is tight (length 2*INTERVAL - 1 admits a 1-sample window).
GenTwoSamples ==
  \A g \in GenWins :
    (g.hi - g.lo >= 2 * INTERVAL) =>
      Cardinality(SamplesIn(g.lo, g.hi)) >= 2

=============================================================================
