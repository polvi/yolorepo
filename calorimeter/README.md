# calorimeter

A calorie counter for local LLMs. Runs models through Ollama on Apple Silicon,
samples SoC power (CPU + GPU + ANE) via `powermetrics` while they generate, and
reports energy in **food calories (kcal) per 1M tokens**, the same denominator
providers use for pricing.

## Usage

```sh
sudo -v                       # cache credentials; powermetrics needs root
bun run start run llama3.2:1b llama3.2:3b --tokens 256
```

Flags:

- `--tokens N` — output tokens generated per model (default 256). Results are
  extrapolated to per-1M-token figures, so small values are fine for quick
  tests; larger values average out sampling noise and thermal drift.
- `--interval MS` — powermetrics sampling interval (default 200).
- `--baseline S` — idle baseline measurement window in seconds (default 8).
- `--json FILE` — dump raw results as JSON.

## Method

1. Sample combined CPU+GPU+ANE power continuously at the given interval.
2. Measure an idle baseline before any inference.
3. Per model: warmup generation (loads the model, excluded from measurement),
   settle, then a timed generation of `--tokens` tokens.
4. Integrate (power − baseline) over the generation window → Joules → kcal
   (÷ 4184). Report per 1M output tokens.

Numbers are SoC rail power, not wall power (no display/SSD/fan/PSU losses).
That makes cross-model comparisons on one machine fair; absolute figures are
estimates (powermetrics derives GPU power from internal counters, ±10–15%).

Confounders to keep in mind: thermal throttling on long runs, background
processes inflating the baseline, and model load energy (deliberately excluded,
matching how providers price per-token).

## Fun units

- 1 food calorie (kcal) = 4,184 J
- One apple ≈ 95 kcal
- A resting human brain runs ≈ 20 W
