// ==UserScript==
// @name         openmonkey scanner (TPX)
// @description  Adds a "Scan with my model" button to openmonkey script pages. Audits the exact source through your own TPX key and publishes the verdict to the registry.
// @version      1.0.0
// @match        https://openmonkey.proc.io/scripts/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.tokenpony.dev
// ==/UserScript==
(function () {
  "use strict";

  var API = "https://api.openmonkey.proc.io/api";
  var m = location.pathname.match(/^\/scripts\/([a-z0-9-]+)$/);
  if (!m) return; // list page or raw .user.js — nothing to do
  var slug = m[1];

  var gm = typeof GM !== "undefined" ? GM : null;
  var store = {
    get: function (k) {
      return gm && gm.getValue ? gm.getValue(k) : Promise.resolve(localStorage.getItem("om_" + k));
    },
    set: function (k, v) {
      return gm && gm.setValue ? gm.setValue(k, v) : Promise.resolve(localStorage.setItem("om_" + k, v));
    },
  };

  var SYSTEM =
    'You are auditing a browser userscript before a human runs it. Judge only the code given.\n' +
    'Respond with ONLY a JSON object: {"verdict":"pass|warn|fail","summary":"at most two sentences"}.\n' +
    "fail: exfiltrates data or credentials, injects hidden remote code, manipulates accounts or payments, or hides behavior (obfuscation plus network calls).\n" +
    "warn: overly broad @match, fetches remote code or config, collects more data than its stated purpose needs, or is too obfuscated to be sure.\n" +
    "pass: does what its metadata says with no meaningful risk.";

  function config(force) {
    return store.get("tpx_key").then(function (key) {
      return store.get("tpx_model").then(function (model) {
        if (force || !key) {
          key = prompt("TPX personal key (sk_…) — mint one at https://api.tokenpony.dev/dashboard", key || "");
          if (!key) return null;
        }
        if (force || !model) {
          model = prompt("Model id to scan with (list: https://api.tokenpony.dev/v1/models)", model || "llama-3.3-70b");
          if (!model) return null;
        }
        key = key.trim();
        model = model.trim();
        return Promise.all([store.set("tpx_key", key), store.set("tpx_model", model)]).then(function () {
          return { key: key, model: model };
        });
      });
    });
  }

  function tpxChat(cfg, messages) {
    var body = JSON.stringify({ model: cfg.model, messages: messages, temperature: 0 });
    var headers = { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key };
    if (gm && gm.xmlHttpRequest) {
      return new Promise(function (resolve, reject) {
        gm.xmlHttpRequest({
          method: "POST",
          url: "https://api.tokenpony.dev/v1/chat/completions",
          headers: headers,
          data: body,
          onload: function (r) {
            if (r.status < 300) resolve(JSON.parse(r.responseText));
            else reject(new Error("TPX " + r.status + ": " + r.responseText.slice(0, 200)));
          },
          onerror: function () {
            reject(new Error("TPX request failed"));
          },
        });
      });
    }
    return fetch("https://api.tokenpony.dev/v1/chat/completions", {
      method: "POST",
      headers: headers,
      body: body,
    }).then(function (r) {
      if (!r.ok)
        return r.text().then(function (t) {
          throw new Error("TPX " + r.status + ": " + t.slice(0, 200));
        });
      return r.json();
    });
  }

  function scan(btn, status) {
    return config(false).then(function (cfg) {
      if (!cfg) return;
      btn.disabled = true;
      status("fetching source…");
      var version;
      return fetch(API + "/scripts/" + slug)
        .then(function (r) {
          if (!r.ok) throw new Error("could not fetch script (" + r.status + ")");
          return r.json();
        })
        .then(function (data) {
          version = data.version;
          status("scanning v" + version.version + " with " + cfg.model + "…");
          return tpxChat(cfg, [
            { role: "system", content: SYSTEM },
            { role: "user", content: "Script: " + data.script.name + "\n\n" + version.code },
          ]);
        })
        .then(function (out) {
          var text = (out.choices && out.choices[0] && out.choices[0].message.content) || "";
          var match = text.match(/\{[\s\S]*\}/);
          var verdict = match ? JSON.parse(match[0]) : {};
          if (["pass", "warn", "fail"].indexOf(verdict.verdict) === -1)
            throw new Error("unparseable verdict: " + text.slice(0, 120));
          status("publishing " + verdict.verdict + " verdict…");
          return fetch(API + "/versions/" + version.id + "/scans", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              verdict: verdict.verdict,
              summary: verdict.summary,
              model: cfg.model + " (TPX)",
            }),
          });
        })
        .then(function (pub) {
          if (pub.status === 401) throw new Error("sign in at auth.proc.io first, then retry");
          if (!pub.ok) throw new Error("publish failed (" + pub.status + ")");
          location.reload();
        })
        .catch(function (e) {
          status(String((e && e.message) || e));
          btn.disabled = false;
        });
    });
  }

  function mount() {
    var heading = Array.prototype.find.call(document.querySelectorAll("h2"), function (h) {
      return /community scan verdicts/i.test(h.textContent);
    });
    if (!heading) return;
    var row = document.createElement("p");
    row.style.cssText = "display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap;";
    var btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Scan with my model";
    var cog = document.createElement("a");
    cog.href = "#";
    cog.textContent = "⚙ key/model";
    cog.className = "muted";
    var out = document.createElement("span");
    out.className = "muted";
    var status = function (t) {
      out.textContent = t;
    };
    btn.addEventListener("click", function () {
      scan(btn, status);
    });
    cog.addEventListener("click", function (e) {
      e.preventDefault();
      config(true);
    });
    row.appendChild(btn);
    row.appendChild(cog);
    row.appendChild(out);
    heading.parentNode.insertBefore(row, heading.nextSibling);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
