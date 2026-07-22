/* global chrome, browser */
const ext = typeof browser !== "undefined" ? browser : chrome;

function send(msg) {
  return new Promise((resolve) => ext.runtime.sendMessage(msg, resolve));
}

async function load() {
  const resp = await send({ type: "getSettings" });
  if (!resp || !resp.ok) return;
  document.getElementById("endpoint").value = resp.result.tpxEndpoint;
  document.getElementById("key").value = resp.result.tpxKey;
  document.getElementById("model").value = resp.result.tpxModel;
}

document.getElementById("save").addEventListener("click", async () => {
  const settings = {
    tpxEndpoint: document.getElementById("endpoint").value.trim() || "https://api.tokenpony.dev/v1",
    tpxKey: document.getElementById("key").value.trim(),
    tpxModel: document.getElementById("model").value.trim() || "llama-3.3-70b",
  };
  await send({ type: "saveSettings", settings });
  const saved = document.getElementById("saved");
  saved.style.display = "inline";
  setTimeout(() => (saved.style.display = "none"), 1500);
});

load();
