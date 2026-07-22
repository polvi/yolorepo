/* global chrome, browser */
const ext = typeof browser !== "undefined" ? browser : chrome;

function send(msg) {
  return new Promise((resolve) => ext.runtime.sendMessage(msg, resolve));
}

const $ = (id) => document.getElementById(id);

let generatedCode = null;

async function refreshStatus() {
  const [me, settings] = await Promise.all([send({ type: "whoami" }), send({ type: "getSettings" })]);
  const user = me && me.ok ? me.result : null;
  const hasKey = settings && settings.ok && !!settings.result.tpxKey;
  const parts = [];
  parts.push(
    user
      ? `Signed in as ${user.handle || user.id.slice(0, 8)}`
      : `<a href="https://auth.proc.io/login?return_to=https://openmonkey.proc.io/scripts" target="_blank">Sign in</a> to publish`
  );
  parts.push(hasKey ? "inference connected" : `<a href="#" id="fix-key">connect inference</a>`);
  $("status").innerHTML = parts.join(" · ");
  const fix = $("fix-key");
  if (fix) fix.addEventListener("click", openOptions);
}

function openOptions(e) {
  if (e) e.preventDefault();
  ext.runtime.openOptionsPage();
}

async function refreshInstalled() {
  const resp = await send({ type: "list" });
  const el = $("installed");
  el.innerHTML = "";
  const items = resp && resp.ok ? Object.values(resp.result) : [];
  if (items.length === 0) {
    el.innerHTML = `<div class="muted">Nothing installed yet. Generate one above or <a href="https://openmonkey.proc.io/scripts" target="_blank">browse the registry</a>.</div>`;
    return;
  }
  for (const s of items.sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1))) {
    const card = document.createElement("div");
    card.className = "card";
    const badge = s.isAuthor
      ? `<span class="badge author">yours</span>`
      : s.scan
        ? `<span class="badge ${s.scan.verdict}">${s.scan.verdict}${s.overridden ? " (accepted)" : ""}</span>`
        : "";
    card.innerHTML = `
      <div class="row">
        <div>
          <strong>${escapeHtml(s.name)}</strong> ${badge}
          <div class="muted">v${s.version} · by ${escapeHtml(s.author || "anonymous")}</div>
        </div>
        <div style="display:flex; gap:4px;">
          <button class="ghost toggle">${s.enabled ? "On" : "Off"}</button>
          <button class="ghost remove">✕</button>
        </div>
      </div>`;
    card.querySelector(".toggle").addEventListener("click", async () => {
      await send({ type: "toggle", scriptId: s.scriptId });
      refreshInstalled();
    });
    card.querySelector(".remove").addEventListener("click", async () => {
      await send({ type: "remove", scriptId: s.scriptId });
      refreshInstalled();
    });
    el.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

$("generate").addEventListener("click", async () => {
  const description = $("describe").value.trim();
  if (!description) return;
  $("generate").textContent = "Generating…";
  $("generate").disabled = true;
  const resp = await send({ type: "generate", description });
  $("generate").textContent = "Generate";
  $("generate").disabled = false;
  if (!resp || !resp.ok) {
    alert(resp && resp.error === "no_tpx_key" ? "Connect inference in Options first." : `Generation failed: ${resp && resp.error}`);
    return;
  }
  generatedCode = resp.result;
  $("preview").textContent = generatedCode;
  const nameMatch = generatedCode.match(/@name\s+(.+)/);
  $("preview-name").textContent = nameMatch ? nameMatch[1].trim() : "userscript";
  $("preview-wrap").style.display = "block";
});

$("publish").addEventListener("click", async () => {
  if (!generatedCode) return;
  $("publish").textContent = "Publishing…";
  $("publish").disabled = true;
  const resp = await send({ type: "publish", code: generatedCode });
  $("publish").disabled = false;
  if (resp && resp.ok) {
    $("publish").textContent = "Published ✓";
    $("preview-wrap").style.display = "none";
    $("describe").value = "";
    generatedCode = null;
    refreshInstalled();
  } else {
    $("publish").textContent = "Publish & install";
    alert(
      resp && resp.error && resp.error.includes("401")
        ? "Sign in first (link at the top), then try again."
        : `Publish failed: ${resp && resp.error}`
    );
  }
});

$("open-options").addEventListener("click", openOptions);

refreshStatus();
refreshInstalled();
