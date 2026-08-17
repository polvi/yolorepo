# pi-local

pi.dev running fully local: [pi](https://pi.dev) as the agent, llama.cpp as the
inference server, Qwen3.8-27B on an M1 Max 64 GB. No tokens leave the laptop.

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
pi-llama-up                                     # start (~50 s to load 24 GiB)
pi-llama-status                                 # what is running, and its RSS
pi --provider llama-cpp --model qwen3.8-27b     # talk to it
pi-llama-down
```

The config file is re-read every time you open `/model` inside pi, so a
provider edit needs no restart.

## Model choice

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

| Context | Resident | Headroom |
|---|---|---|
| 65 536 (default) | 27.9 GiB | 26.5 GiB |
| 262 144 (model native max) | 40.0 GiB | 14.4 GiB |

KV costs about 64 KiB per token, so 64K of context is only ~4 GiB. The default
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
| `--mmproj mmproj-BF16.gguf` | Qwen3.8 is natively multimodal, so the agent can read screenshots |
| `--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0` | Qwen's published thinking-mode sampling |

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

- server reports 65 536 tokens across 1 slot, alias `qwen3.8-27b`
- multimodal projector loads, so `input: ["text", "image"]` is honest
- `--thinking off` and `--thinking medium` both work; thinking arrives as
  `reasoning_content` and pi renders it as a `thinking` block
- tool calling works end to end (read a file, returned its contents)
- pi reports `cacheRead` on follow-up turns, so prefix reuse is live

## Configuration

Every knob is an environment variable, readable from `~/.pi-local.env`:

| Variable | Default |
|---|---|
| `PI_LLAMA_REPO` | `unsloth/Qwen3.8-27B-GGUF` |
| `PI_LLAMA_QUANT` | `UD-Q6_K_XL` |
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

- `id` must equal the server's `--alias` (`qwen3.8-27b`); that is what
  `/v1/models` advertises and what pi sends as the model name.
- `contextWindow` tells pi when to compact. Keep it equal to `PI_LLAMA_CTX`.

`cost` is all zeros, which is the honest number and keeps pi's session
accounting from inventing spend.

## Trade-offs worth knowing

Generation runs at roughly 6 t/s. That is fine for review, refactors, and
questions about a codebase, and slow for long autonomous edit loops. The model
is memory-bandwidth bound, so the only real lever left on this hardware is a
smaller model, not a different flag.
