# devpod

A persistent Claude Code environment in the `proc-proc-dev` k8s cluster. The
point: run Claude Code inside tmux on the cluster, so long-running sessions
survive your laptop sleeping, closing, or losing network. Detach, go offline,
reattach later, the session is exactly where you left it.

## How it works

- A single-replica Deployment in the `devpod` namespace runs a stock
  `debian:bookworm` container. No custom image, no registry.
- `/home/dev` is a 50Gi mayastor PVC (`mayastor-retain`). Everything that
  matters lives there: the repo clone, `~/.claude` (including credentials
  after you log in once), bun, the Claude Code install, your SSH key, tmux
  history. Pod restarts keep all of it.
- On every pod start, `bootstrap.sh` (from a ConfigMap) reinstalls the OS
  packages (tmux, git, build tools) into the ephemeral layer, installs
  bun and Claude Code into the PVC if missing, clones the repo if missing,
  and pre-starts a tmux session named `main`.

One caveat by design: tmux and the processes inside it live in the container,
so a pod restart (node reboot, OOM, manifest change) ends the running tmux
session. Files and login state survive; the in-flight Claude conversation can
be picked back up with `claude --resume`.

## First-time setup

```sh
devpod/bin/devpod-up            # kubectl apply -k devpod/k8s/ + wait for ready
devpod/bin/devpod-sync-claude   # copy ~/.claude/{CLAUDE.md,settings.json} in
devpod/bin/devpod-attach        # attach to the tmux session
```

Then, inside the pod (one time each, all persisted on the PVC):

1. **Claude login**: run `claude` and complete the OAuth login in a browser
   on your laptop. Credentials land in `~/.claude` on the PVC.
   Alternative: run `claude setup-token` on your laptop and export the
   result as `CLAUDE_CODE_OAUTH_TOKEN` in the pod's `~/.bashrc`.
2. **GitHub push access**: the bootstrap generated an SSH key. Print it with
   `cat ~/.ssh/id_ed25519.pub` and add it at github.com/settings/keys.
   The clone falls back to HTTPS, so switch the remote after adding the key:
   `git remote set-url origin git@github.com:polvi/yolorepo.git`.
3. **Wrangler auth**: wrangler and Node LTS are installed by the bootstrap.
   `wrangler login` in the pod prints an OAuth URL and listens on
   localhost:8976 for the callback, so forward that port first from your
   laptop, then open the URL in your laptop browser:

   ```sh
   # laptop
   kubectl -n devpod port-forward deploy/devpod 8976:8976
   # pod
   wrangler login
   ```

   The OAuth token lands in `~/.config/.wrangler/` on the PVC and refreshes
   itself from then on. Alternative for fully headless auth: create an API
   token at dash.cloudflare.com/profile/api-tokens and add
   `export CLOUDFLARE_API_TOKEN=...` to `~/.bashrc` in the pod.
4. **cloudflared** (installed by the bootstrap): for authenticated use
   (named tunnels), run `cloudflared tunnel login` in the pod and open the
   printed URL in your laptop browser; the cert arrives directly to the pod
   (no port-forward needed) and persists at `~/.cloudflared/cert.pem`.
   Quick tunnels (`cloudflared tunnel --url http://localhost:PORT`) need no
   auth at all and are handy for exposing a dev server from the pod.

## Daily use

```sh
devpod/bin/devpod-attach        # attach (creates session "main" if needed)
# ... work in claude ...
# Ctrl-b d to detach; close the laptop; everything keeps running
devpod/bin/devpod-attach        # later, from anywhere with kubectl access
```

- `devpod/bin/devpod-attach <name>` attaches or creates another named
  session.
- `devpod/bin/devpod-shell` gives a plain shell without tmux.
- New tmux windows: `Ctrl-b c`, switch with `Ctrl-b n`/`Ctrl-b p`.

## Operations

- **Update manifests**: edit `devpod/k8s/`, then `devpod/bin/devpod-up`.
  Changing the bootstrap ConfigMap requires a restart to take effect:
  `kubectl -n devpod rollout restart deploy/devpod` (this kills tmux, see
  caveat above).
- **Logs / boot progress**: `kubectl -n devpod logs deploy/devpod -f`.
- **Tear down but keep data**: `kubectl -n devpod delete deploy/devpod`.
  The PVC (and the retained mayastor volume) stay.
- **Full teardown**: `kubectl delete -k devpod/k8s/`. The storage class is
  `Retain`, so the underlying volume still needs manual deletion if you
  truly want the data gone.

## Layout

```
devpod/
  k8s/                      # kubectl apply -k devpod/k8s/
    namespace.yaml
    pvc.yaml                # 50Gi mayastor-retain -> /home/dev
    configmap-bootstrap.yaml# bootstrap.sh (install + tmux + sleep)
    deployment.yaml
    kustomization.yaml
  bin/
    devpod-up               # apply + wait
    devpod-attach           # tmux new -A -s main via kubectl exec
    devpod-shell            # plain bash via kubectl exec
    devpod-sync-claude      # kubectl cp local ~/.claude config into the pod
```
