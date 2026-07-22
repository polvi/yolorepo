// OpenMonkey content script: injects installed userscripts into matching pages
// and bridges the openmonkey.proc.io site's Install button to the extension.
/* global chrome, browser */
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        ext.runtime.sendMessage(msg, (resp) => resolve(resp));
      } catch {
        resolve(null);
      }
    });
  }

  // ---- userscript injection ----

  function runInContentWorld(code, name) {
    try {
      new Function(code)();
      return true;
    } catch (e) {
      if (e instanceof EvalError) return false; // page/extension CSP forbids eval here
      console.error(`[openmonkey] "${name}" threw:`, e);
      return true; // it ran; the script itself errored
    }
  }

  function runInPageWorld(code, name) {
    const el = document.createElement("script");
    el.textContent = `/* openmonkey: ${name} */\n${code}`;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  }

  async function injectMatching() {
    const resp = await send({ type: "getForUrl", url: location.href });
    if (!resp || !resp.ok) return;
    for (const s of resp.result) {
      if (!runInContentWorld(s.code, s.name)) runInPageWorld(s.code, s.name);
    }
  }

  injectMatching();

  // ---- site bridge (install button on openmonkey.proc.io) ----

  if (location.origin === "https://openmonkey.proc.io" || location.hostname === "localhost") {
    window.addEventListener("message", async (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!data || data.type !== "openmonkey:install") return;
      window.postMessage({ type: "openmonkey:install-ack" }, location.origin);

      let resp = await send({ type: "install", slug: data.slug });
      if (resp && resp.ok && resp.result.status === "needs_override") {
        const scan = resp.result.scan;
        const accept = window.confirm(
          `OpenMonkey scan verdict: WARN\n\n${scan.summary}\n\nRisks:\n- ${(scan.risks || []).join("\n- ")}\n\nInstall anyway?`
        );
        if (accept) {
          resp = await send({ type: "install", slug: data.slug, override: true });
        } else {
          window.postMessage({ type: "openmonkey:install-blocked" }, location.origin);
          return;
        }
      }

      if (resp && resp.ok && resp.result.status === "installed") {
        window.postMessage({ type: "openmonkey:install-done" }, location.origin);
      } else {
        const scan = resp && resp.ok ? resp.result.scan : null;
        if (scan) {
          window.alert(`OpenMonkey blocked this install.\n\nScan verdict: FAIL\n${scan.summary}`);
        } else if (resp && !resp.ok && resp.error === "no_tpx_key") {
          window.alert(
            "OpenMonkey needs an inference endpoint to scan scripts before installing.\nOpen the extension options and add your tokenpony key (or your own endpoint)."
          );
        }
        window.postMessage({ type: "openmonkey:install-blocked" }, location.origin);
      }
    });
  }
})();
