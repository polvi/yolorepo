# pi-local

pi.dev running fully local: [pi](https://pi.dev) as the agent, llama.cpp as the
inference server, on an M1 Max 64 GB. No tokens leave the laptop.

Three models are configured. **Qwen3.6-35B-A3B is the default and the one to
use** — it is the fastest, the smallest in memory, and the only one that got
every task in the eval suite right. See [MODELS.md](MODELS.md) for the
measured comparison and the routing rule.

Infra-only, no proc subdomain.

## Install

```sh
brew install llama.cpp          # provides llama-server
bun add -g @earendil-works/pi-coding-agent
./bin/install.sh --default      # --launchd also starts the server at login
```

`install.sh` symlinks the three helper scripts into `~/.local/bin` and *merges*
the `llama-cpp` provider into `~/.pi/agent/models.json`, leaving any other
providers you have alone. `--default` additionally sets `defaultProvider` and
`defaultModel` in `~/.pi/agent/settings.json`, so a bare `pi` talks to the
local server.

## Use

```sh
pi-llama-up                                     # start the default model
pi-llama-status                                 # what is running, and its RSS
pi                                              # talk to it
pi-llama-down
```

Switch models by restarting the server with different env:

```sh
PI_LLAMA_REPO=unsloth/Qwen3.8-27B-GGUF \
PI_LLAMA_QUANT=UD-Q6_K_XL \
PI_LLAMA_ALIAS=qwen3.8-27b pi-llama-up
```

Fetch a new model with the parallel downloader (Hugging Face throttles a
single connection to a few MB/s):

```sh
pi-llama-fetch unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
```

The config file is re-read every time you open `/model` inside pi, so a
provider edit needs no restart.

## Model choice

Which *model* to run is settled in [MODELS.md](MODELS.md), measured across
three models and six verified tasks. Short version: Qwen3.6-35B-A3B, a 3B-active
MoE, is 9× the prefill and 8× the generation of the dense 27B at equal
correctness, in less memory.

What follows is the earlier *quantization* study for the dense 27B, kept
because the reasoning generalizes: on this machine the bottleneck is memory
bandwidth, so a smaller quant buys nothing.

Three quantizations of Qwen3.8-27B, benchmarked on this machine:

| Quant | Size | Prompt | Generation | Verdict |
|---|---|---|---|---|
| UD-Q4_K_XL | 16.68 GiB | 58.1 t/s | 5.62 t/s | skip |
| UD-Q5_K_XL | 18.82 GiB | 88.8 t/s | 5.96 t/s | good |
| **UD-Q6_K_XL** | **24.13 GiB** | **85.7 t/s** | **6.38 t/s** | **chosen** |

Q6 wins outright: highest precision, fastest generation, prompt processing
within noise of Q5, and it still fits with room to spare. Q4 is dominated on
every axis, which is what you expect when the bottleneck is memory bandwidth
rather than capacity.

Weights come from
[unsloth/Qwen3.8-27B-GGUF](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF)
and are read straight out of the Hugging Face cache
(`~/.cache/huggingface/hub`), so nothing is downloaded twice.

## Memory budget

Metal reports `recommendedMaxWorkingSetSize = 54.4 GiB` on this 64 GB machine.
Measured resident size of the server, model fully offloaded, f16 KV cache:

| Model, context | Resident | Headroom |
|---|---|---|
| Qwen3.6-35B-A3B Q4, 65 536 (default) | 23.1 GiB | 31.3 GiB |
| Qwen3.8-27B Q6, 65 536 | 29.1 GiB | 25.3 GiB |
| Qwen3.8-27B Q6, 262 144 (native max) | 40.0 GiB | 14.4 GiB |
| Qwen3-Coder-Next IQ4_XS, 65 536 | 37.4 GiB | 17.0 GiB |

For the dense 27B, KV costs about 64 KiB per token, so 64K of context is only
~4 GiB. The default
is 64K because that is a comfortable working window for an agent, not because
of memory. Raise it whenever a job wants more:

```sh
PI_LLAMA_CTX=131072 pi-llama-up
```

and match `contextWindow` in `~/.pi/agent/models.json`, otherwise pi will
compact at 64K regardless of what the server can hold.

Because the KV cache is this cheap, keeping it at f16 is the right call.
Quantizing it (`PI_LLAMA_KV_TYPE=q8_0`) would save ~2 GiB at 64K and cost
accuracy for no reason.

## Server flags, and why

| Flag | Reason |
|---|---|
| `--n-gpu-layers 99` | full Metal offload; anything on CPU would dominate the runtime |
| `--flash-attn on` | faster attention, smaller KV footprint |
| `--parallel 1` | one slot, so the whole context belongs to one conversation instead of being split across slots |
| `--ctx-size 65536` | target working window |
| `--cache-type-k/v f16` | KV is cheap here, so do not trade accuracy away |
| `--cache-reuse 256` | reuse prefix chunks across agent turns; agent loops re-send a long, near-identical prefix every step |
| `--no-context-shift` | overflow should be a loud error, not silent truncation of tool-call history |
| `--jinja` | use the model's own chat template, which is what carries tool calling and the thinking toggle |
| `--reasoning-format deepseek` | emit thinking as `reasoning_content`, the field OpenAI-compatible clients read |
| `--reasoning-preserve` | keep the thinking trace across tool-call round trips; the template supports it |
| `--mmproj mmproj-BF16.gguf` | the Qwen models are natively multimodal, so the agent can read screenshots; skipped when the repo has no projector, as Coder-Next does not |
| `--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0` | Qwen's published thinking-mode sampling; pi overrides these per model via `samplingParams` |

### Batch sizes, tested rather than guessed

`llama-bench` on this machine, Q6, flash attention on, pp2048 / tg64:

| `-b` | `-ub` | prompt t/s | gen t/s |
|---|---|---|---|
| 2048 | **512** | 74.3 ± 1.5 | 5.94 |
| 2048 | 1024 | 73.9 ± 0.2 | 6.03 |
| 2048 | 2048 | 65.1 ± 0.2 | 6.03 |
| 4096 | 512 | 87.7 ± 10.5 | 6.08 |
| 4096 | 1024 | 74.8 ± 0.4 | 6.04 |
| 4096 | 2048 | 67.9 ± 1.2 | 6.11 |

Raising `-ub` to 2048 costs ~12% of prompt throughput; `-b 4096` looks like a
win but its error bar swallows the difference. The stock `2048 / 512` stays.

## Verified

Against a live server (`llama.cpp` build 10450, pi 0.84.2):

- server reports 65 536 tokens across 1 slot for each of the three models
- multimodal projector loads for the two vision models, so
  `input: ["text", "image"]` is honest
- `--thinking off` and `--thinking medium` both work; thinking arrives as
  `reasoning_content` and pi renders it as a `thinking` block
- tool calling works end to end (read a file, returned its contents)
- pi reports `cacheRead` on follow-up turns, so prefix reuse is live

## Configuration

Every knob is an environment variable, readable from `~/.pi-local.env`:

| Variable | Default |
|---|---|
| `PI_LLAMA_REPO` | `unsloth/Qwen3.6-35B-A3B-GGUF` |
| `PI_LLAMA_QUANT` | `UD-Q4_K_XL` |
| `PI_LLAMA_ALIAS` | `qwen3.6-35b-a3b` |
| `PI_LLAMA_MODEL` | unset; an explicit `.gguf` path, bypassing all lookup |
| `PI_LLAMA_MODEL_DIR` | `~/models`, searched after the HF cache |
| `PI_LLAMA_CTX` | `65536` |
| `PI_LLAMA_PORT` | `8080` |
| `PI_LLAMA_HOST` | `127.0.0.1` |
| `PI_LLAMA_BATCH` / `PI_LLAMA_UBATCH` | `2048` / `512` |
| `PI_LLAMA_KV_TYPE` | `f16` |
| `PI_LLAMA_VISION` | `1` |
| `PI_LLAMA_LOG` | `~/Library/Logs/pi-llama.log` |

## pi provider

`config/models.json` holds the canonical copy of what `install.sh` merges in.
Two details matter:

- `id` must equal the server's `--alias`; that is what `/v1/models` advertises
  and what pi sends as the model name.
- `contextWindow` tells pi when to compact. Keep it equal to `PI_LLAMA_CTX`.
- `reasoning` must be `false` for Coder-Next, which emits no thinking blocks.

`cost` is all zeros, which is the honest number and keeps pi's session
accounting from inventing spend.

All three models are registered at once even though only one can be loaded.
pi will happily list a model whose server is not running; the request just
fails until you restart the server with the matching env.

## Evaluating

`bench/eval.ts` runs six verified tasks against each model and writes
`bench/results.json`:

```sh
bun bench/eval.ts                      # every model, restarting the server per model
bun bench/eval.ts qwen3.6-35b-a3b      # one model
bun bench/eval.ts --task=code-repair   # one task
```

Each task is graded by inspecting the filesystem or running a test suite the
model never saw, so a pass means the work happened rather than was described.
The two hardest tasks are graded by hidden suites that are themselves checked
against a known-good and a known-bad reference, so they discriminate rather
than passing anything that compiles.

## Trade-offs worth knowing

On the default model, generation runs at ~47 t/s and prefill at ~686 t/s,
which is comfortable for agent loops. The dense 27B is ~8× slower on both and
worth it only when you want its stronger single-shot reasoning. See
[MODELS.md](MODELS.md).
