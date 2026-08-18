# clusterpilot

A read-only agent that inspects a Talos Linux Kubernetes cluster and writes an
upgrade plan. It reasons with a local model on your own llama.cpp server, so
nothing about your infrastructure leaves the machine.

Built on the [pi.dev SDK](https://pi.dev/docs/latest/sdk).

```bash
bun run src/index.ts status   # collect cluster state and computed findings, no model
bun run src/index.ts plan     # collect, analyze, and write an upgrade plan
bun run src/index.ts ask "is etcd healthy?"
bun run src/index.ts model    # show which model the local server has loaded
```

## It only ever looks

Clusterpilot plans upgrades. It never performs them. Every external command
goes through one allowlist in `src/exec.ts`: the binary must be `talosctl`,
`kubectl`, or `helm`, the subcommand must be a known read-only one, and no
argument anywhere in the argv may be a mutating verb. The model's `probe` tool
routes through the same check, so a confused or adversarial model gets a
refusal rather than a live cluster.

Asked to delete a deployment, it answers with the command for you to run:

```
I can't run mutating commands like `kubectl delete`. My only tool is read-only
and delete operations are explicitly refused.
```

## What the model does and does not decide

Version arithmetic is not something to hand a language model, least of all a
30B one running locally. The split:

| In code (`src/analyze.ts`, `src/semver.ts`) | In the model |
| --- | --- |
| Which versions are behind, and by how much | Sequencing and grouping into maintenance windows |
| The upgrade path, one minor at a time | Risk framing and what to verify at each step |
| Which installer image each node needs | Honest rollback scope |
| Health signals that block an upgrade | Prose |

Findings arrive in the prompt already computed and marked as verified, and the
system prompt tells the model not to recompute them or invent versions. The
written plan carries an appendix of the computed findings and every probe that
ran, so you can check the model's work against the evidence it was given.

## Talos specifics it knows about

These are the things a general-purpose model gets wrong about Talos, so they
are encoded rather than hoped for:

- **Image Factory schematics.** A node built with system extensions carries a
  schematic ID. Upgrading with the stock `ghcr.io/siderolabs/installer` instead
  of `factory.talos.dev/installer/<schematic>` silently drops every extension.
  On a cluster whose storage driver is an extension, the volumes stop working
  after the reboot. Clusterpilot reads the schematic off the node and builds
  the correct image URL.
- **No kubeadm, no SSH, no package manager.** Kubernetes moves with
  `talosctl upgrade-k8s`, not Helm and not kubeadm.
- **One minor at a time**, landing on the newest patch of each.
- **Single-node clusters** have no drain target and no etcd quorum, so every
  upgrade is a full outage, `--preserve` is required, and an etcd snapshot is
  the only rollback that exists. Two control-plane nodes get flagged too: a
  2-member etcd cluster loses quorum when either member goes down.
- **Prerelease chart versions are never upgrade targets.** Some repos publish
  `-develop` builds numbered above the newest stable release.

## Model

The agent uses whatever model your llama.cpp server currently has loaded. It
asks the server rather than pinning a name in config, because llama-server
holds one model at a time and the weights are tens of gigabytes: a swap is not
a cheap accident. Clusterpilot writes its own `models.json` for pi, so it works
whether or not `~/.pi/agent` has been configured.

Start a server with [`pi-local`](../pi-local) (`pi-llama-up`), or point
`LLAMA_BASE_URL` anywhere OpenAI-compatible.

## Configuration

Everything is optional; the defaults discover the cluster from your ambient
kubeconfig. Drop a `clusterpilot.config.json` next to the source to override:

```json
{
  "kubeContext": "proc-proc-dev",
  "talosNodes": ["proc-0"],
  "helmRepos": { "my-chart": "https://example.com/charts" },
  "llamaBaseUrl": "http://127.0.0.1:8080/v1"
}
```

| Environment | Effect |
| --- | --- |
| `LLAMA_BASE_URL` | OpenAI-compatible endpoint (default `http://127.0.0.1:8080/v1`) |
| `CLUSTERPILOT_CONTEXT` | Override the kubectl context |
| `GITHUB_TOKEN` | Raises the GitHub rate limit for release lookups |
| `TALOSCTL` / `KUBECTL` / `HELM` | Binary paths |

A chart with no entry in `helmRepos` is reported as "no upstream configured"
rather than being silently skipped.

## Layout

```
src/
  exec.ts        the read-only allowlist; every command goes through it
  probes/        talosctl, kubectl, and helm collectors
  upstream/      GitHub releases and Helm repo indexes
  semver.ts      version comparison and upgrade paths
  analyze.ts     deterministic findings
  prompt.ts      the Talos upgrade doctrine given to the model
  tools.ts       the model's single `probe` tool
  agent.ts       the pi SDK session
  render.ts      the prompt digest and the written plan
```

## Tests

```bash
bun test        # allowlist, semver, upgrade paths, parsers
bunx tsc --noEmit
```

The allowlist tests are the ones that matter: they assert that every mutating
verb is refused, wherever it appears in the argv.
