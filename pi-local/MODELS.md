# Which local model, and when

Three models, all served by the same `llama-server` on port 8080, all
registered as pi providers. This is the measured comparison and the routing
rule that falls out of it.

Everything here was measured on this machine (M1 Max 64 GB, llama.cpp build
10450, pi 0.84.2), not copied from model cards. Reproduce with
`bun bench/eval.ts`.

## The answer

Use **Qwen3.6-35B-A3B**. It is the fastest of the three, the smallest in
memory, and the only one that got every task right. The 80B coder model is
bigger, slower, and less accurate; the dense 27B matches it on correctness but
takes five times as long.

## The numbers

Raw throughput, `llama-bench`, flash attention on, full Metal offload:

| Model | Quant | Weights | Prefill (pp2048) | Generate (tg64) | Resident at 64K |
|---|---|---|---|---|---|
| Qwen3.8-27B dense | UD-Q6_K_XL | 24.1 GiB | 74.3 t/s | 5.9 t/s | 29.1 GiB |
| **Qwen3.6-35B-A3B** | UD-Q4_K_XL | 20.8 GiB | **685.6 t/s** | **46.9 t/s** | **23.1 GiB** |
| Qwen3-Coder-Next 80B-A3B | UD-IQ4_XS | 35.8 GiB | 393.4 t/s | 40.4 t/s | 37.4 GiB |

Task suite, six tasks, each verified by inspecting the filesystem or running a
test suite the model never saw:

| Task | What it checks | 27B dense | 35B-A3B | Coder-Next |
|---|---|---|---|---|
| tool-chain | read → compute → write | pass 98.9s | pass 14.5s | pass **8.8s** |
| code-repair | make a failing `bun test` pass | pass 150.7s | pass **21.6s** | pass 40.2s |
| hidden-tests | code judged by an unseen suite | pass 101.4s | pass 17.5s | pass **16.5s** |
| async-concurrency | correct concurrency limiter | pass 245.9s | pass **59.3s** | **fail** 15.0s |
| long-context | needle in a ~31K token prompt | pass 396.1s | pass **87.0s** | pass 107.7s |
| instruction | exact output format | pass 10.6s | pass **2.5s** | pass 6.3s |
| **total** | | **6/6, 1004s** | **6/6, 202s** | **5/6, 195s** |

## Why the MoE models win on this hardware

The M1 Max has ~400 GB/s of memory bandwidth and 64 GB of capacity. A dense
27B reads all 25.9 GB of weights for every token it generates, so bandwidth
caps it near 15 t/s no matter what flags you set. A 3B-active MoE reads a
fraction of that per token while still needing the whole model resident.

That is exactly the trade this machine wants: short on bandwidth, long on
capacity. MoE spends the surplus to buy back the scarcity. The result is 9×
the prefill and 8× the generation at equal correctness.

## Why the 80B coder model is not the winner

It looks like it should be: 80B total parameters, agentically trained,
SWE-bench Verified in the low 70s. On this hardware it loses on all three
axes that matter.

**It is slower than the 35B**, because MoE speed tracks bytes read per token,
and Coder-Next reads a 35.8 GiB model's worth of shared and attention weights
against the 35B's 20.8 GiB. Total parameters do not predict speed; resident
size does.

**It costs 14 GiB more memory** for that privilege, which is the difference
between comfortable and cramped once you want a large context.

**It failed the one hard reasoning task.** Given a concurrency limiter to
write, it produced code that fails 5 of 6 hidden tests, including this:

```ts
const task = tasks[nextIndex]++;   // increments a function; yields NaN
```

The likely cause is structural: Coder-Next is a **non-reasoning model** and
emits no thinking blocks at all. The two models that solved this task both
worked through the semantics in a thinking block first. For mechanical work
that costs nothing; for a problem with interacting constraints it is the
whole ballgame.

## A tool-calling quirk worth knowing

Coder-Next's `async-concurrency` failure was two failures stacked. Before the
bad algorithm, it often did not call the write tool at all — it printed the
code in a markdown fence and declared itself finished. The file was never
created.

Two things move that, measured over 3 runs each (small samples, treat as
directional):

| Change | Wrote the file |
|---|---|
| temperature 1.0 (Qwen's recommended) | 1/3 |
| temperature 0.3 | 2/3 |
| prompt says "Use your write tool", explicitly | **3/3** |

So if you do use Coder-Next, name the tool in the instruction rather than
implying it. The other two models never needed this.

## Routing rule

| Situation | Model |
|---|---|
| Everyday coding, agent loops, tool calls | Qwen3.6-35B-A3B |
| Big prompts, whole-file or repo context | Qwen3.6-35B-A3B (686 t/s prefill) |
| Screenshots, diagrams, PDFs | Qwen3.6-35B-A3B or 27B dense (both vision) |
| Hardest single-shot reasoning, willing to wait | Qwen3.8-27B dense |
| Coder-Next | no clear niche on this machine |

Only one model is loaded at a time. Switching is a server restart:

```sh
PI_LLAMA_REPO=unsloth/Qwen3.6-35B-A3B-GGUF \
PI_LLAMA_QUANT=UD-Q4_K_XL \
PI_LLAMA_ALIAS=qwen3.6-35b-a3b pi-llama-up
```

Then pick it inside pi with `/model`, or `pi --model qwen3.6-35b-a3b`.

## Practical notes

**Prefill is the real agent tax.** The 31K-token task cost the dense model
396 seconds, nearly all of it prefill at ~80 t/s. The same prompt costs the
35B-A3B 87 seconds. Prefix caching hides this after the first turn (pi
reports `cacheRead` on follow-ups), but the first turn against an unfamiliar
codebase is where you feel it.

**Thinking is a per-request choice**, and it is the lever that decides the
hard tasks. `pi --thinking off|low|medium|high` maps through `chat-template`
to the model's own `enable_thinking` toggle. Turn it off for mechanical work,
leave it on for anything with interacting constraints.

**Sampling differs per model and per mode.** Qwen publishes different values
for thinking, non-thinking, and coding. `config/models.json` carries the right
ones per model and pi sends them per request, so server defaults barely
matter.

**Hugging Face throttles per connection**, measured at 3.2 MB/s here, which
turns a 38 GB model into a 3-hour download. `pi-llama-fetch` pulls eight byte
ranges in parallel and sustained 40 MB/s on the same file:

```sh
pi-llama-fetch unsloth/Qwen3-Coder-Next-GGUF Qwen3-Coder-Next-UD-IQ4_XS.gguf
```

It writes to `~/models`, which `pi-llama-up` searches after the HF cache, so
the two sources are interchangeable.

## What this suite does not tell you

Every task here is at the difficulty of ordinary agent work, and one hard
reasoning problem. It says nothing about deep domain knowledge, long
multi-file refactors, or tasks needing hours of autonomous work. Published
scores put the dense 27B well ahead on pure reasoning (GPQA Diamond 89.2)
and the coder models ahead on SWE-bench, but those come from different
benchmark versions and are not directly comparable to each other, which is
the reason this suite exists at all.
