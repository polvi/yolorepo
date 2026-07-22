// ==UserScript==
// @name         openmonkey composer (TPX)
// @description  Adds a "Generate with my model" box to the openmonkey publish page. Describe the userscript you want; your own TPX key writes it into the form for review before you publish.
// @version      1.0.0
// @match        https://openmonkey.proc.io/publish
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.tokenpony.dev
// ==/UserScript==
(function () {
  "use strict";

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
    "You write browser userscripts. Output ONLY JavaScript source code for a single userscript, with a standard metadata block:\n\n" +
    "// ==UserScript==\n" +
    "// @name         <short name>\n" +
    "// @description  <one line>\n" +
    "// @version      1.0.0\n" +
    "// @match        <url pattern(s), as specific as possible>\n" +
    "// ==/UserScript==\n\n" +
    "Rules: plain JavaScript (no build steps, no imports, no external script loading), operate only on the matched page's DOM, request no data from third-party servers unless the user's description explicitly requires it. Wrap logic in an IIFE. No explanation text before or after the code.";

  function config(force) {
    return store.get("tpx_key").then(function (key) {
      return store.get("tpx_model").then(function (model) {
        if (force || !key) {
          key = prompt("TPX personal key (sk_…) — mint one at https://api.tokenpony.dev/dashboard", key || "");
          if (!key) return null;
        }
        if (force || !model) {
          model = prompt("Model id to generate with (list: https://api.tokenpony.dev/v1/models)", model || "llama-3.3-70b");
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
    var body = JSON.stringify({ model: cfg.model, messages: messages, temperature: 0.4 });
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

  function stripFences(text) {
    var fenced = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
    return (fenced ? fenced[1] : text).trim();
  }

  function generate(desc, btn, status) {
    var codeBox = document.getElementById("f-code");
    if (!codeBox) {
      status("publish form not found on this page");
      return Promise.resolve();
    }
    return config(false).then(function (cfg) {
      if (!cfg) return;
      btn.disabled = true;
      status("generating with " + cfg.model + "…");
      var messages = [
        { role: "system", content: SYSTEM },
        { role: "user", content: desc },
      ];
      // If the form already holds code, treat this as a revision request.
      if (codeBox.value.trim()) {
        messages[1].content =
          "Revise this userscript per the request below. Same output rules.\n\nRequest: " +
          desc +
          "\n\nCurrent script:\n" +
          codeBox.value;
      }
      return tpxChat(cfg, messages)
        .then(function (out) {
          var text = (out.choices && out.choices[0] && out.choices[0].message.content) || "";
          var code = stripFences(text);
          if (code.indexOf("==UserScript==") === -1)
            throw new Error("model did not return a userscript: " + text.slice(0, 120));
          codeBox.value = code;
          status("done — review the code, then publish");
          btn.disabled = false;
        })
        .catch(function (e) {
          status(String((e && e.message) || e));
          btn.disabled = false;
        });
    });
  }

  function mount() {
    var form = document.getElementById("publish-form");
    if (!form) return;
    var card = document.createElement("div");
    card.className = "card";
    card.style.maxWidth = "42rem";
    var label = document.createElement("p");
    label.style.cssText = "margin:0 0 0.5rem;";
    label.textContent = "Generate with your model (TPX): describe the userscript you want. It lands in the form below for review — read it before you publish.";
    var desc = document.createElement("textarea");
    desc.rows = 3;
    desc.placeholder = "e.g. On github.com pull request pages, add a button that copies the branch name";
    desc.style.cssText =
      "width:100%; padding:0.5rem 0.75rem; background:#0a0d12; border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:inherit; margin-bottom:0.5rem;";
    var row = document.createElement("p");
    row.style.cssText = "display:flex; gap:0.75rem; align-items:center; margin:0;";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn secondary";
    btn.textContent = "Generate with my model";
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
      if (!desc.value.trim()) {
        status("describe the script first");
        return;
      }
      generate(desc.value.trim(), btn, status);
    });
    cog.addEventListener("click", function (e) {
      e.preventDefault();
      config(true);
    });
    row.appendChild(btn);
    row.appendChild(cog);
    row.appendChild(out);
    card.appendChild(label);
    card.appendChild(desc);
    card.appendChild(row);
    form.parentNode.insertBefore(card, form);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
