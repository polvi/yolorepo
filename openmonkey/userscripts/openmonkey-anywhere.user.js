// ==UserScript==
// @name         openmonkey anywhere (TPX)
// @description  Prompt a userscript into existence from the page it will modify. Opens a panel on any site (manager menu command, or the floating 🐵 button), generates a script for that page with a metered TPX grant you approve (OAuth, no API keys), publishes it to openmonkey, and opens it for install. Broad @match is inherent to what it does — scan it: it talks only to TPX and the registry, only when you ask.
// @version      1.0.0
// @match        https://*/*
// @match        http://*/*
// @exclude      https://openmonkey.proc.io/*
// @exclude      https://api.tokenpony.dev/*
// @exclude      https://auth.proc.io/*
// @exclude      https://authgravity.proc.io/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.registerMenuCommand
// @connect      api.tokenpony.dev
// @connect      api.openmonkey.proc.io
// ==/UserScript==
(function () {
  "use strict";

  var API = "https://api.openmonkey.proc.io/api";
  var SITE = "https://openmonkey.proc.io";
  var TPX = "https://api.tokenpony.dev";
  var CALLBACK = SITE + "/oauth/tpx";
  var CLIENT_NAME = "openmonkey anywhere (TPX)";
  var DEFAULT_BUDGET = "0.25";

  // ---- storage (GM with localStorage fallback) ------------------------------

  var gm = typeof GM !== "undefined" ? GM : null;
  var store = {
    get: function (k) {
      return gm && gm.getValue ? gm.getValue(k) : Promise.resolve(localStorage.getItem("om_any_" + k));
    },
    set: function (k, v) {
      return gm && gm.setValue ? gm.setValue(k, v) : Promise.resolve(localStorage.setItem("om_any_" + k, v));
    },
    del: function (k) {
      return gm && gm.deleteValue ? gm.deleteValue(k) : Promise.resolve(localStorage.removeItem("om_any_" + k));
    },
  };

  // ---- tiny HTTP helper (GM.xmlHttpRequest: no CORS, cookies included) ------

  function http(method, url, headers, body) {
    if (gm && gm.xmlHttpRequest) {
      return new Promise(function (resolve, reject) {
        gm.xmlHttpRequest({
          method: method,
          url: url,
          headers: headers,
          data: body,
          onload: function (r) {
            var json;
            try { json = JSON.parse(r.responseText); } catch (e) { json = null; }
            resolve({ status: r.status, json: json, text: r.responseText });
          },
          onerror: function () { reject(new Error("request to " + url + " failed")); },
        });
      });
    }
    return fetch(url, { method: method, headers: headers, body: body, credentials: "include" }).then(function (r) {
      return r.text().then(function (t) {
        var json; try { json = JSON.parse(t); } catch (e) { json = null; }
        return { status: r.status, json: json, text: t };
      });
    });
  }

  function form(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }).join("&");
  }

  // ---- OAuth 2.1 public client: register → PAR → popup → code → token -------
  // The redirect relay at openmonkey.proc.io/oauth/tpx postMessages the code
  // back to this (cross-origin) opener; PKCE keeps the relayed code useless
  // to anyone without the verifier held here.

  function b64url(buf) {
    var s = "";
    var bytes = new Uint8Array(buf);
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString() {
    var b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b64url(b.buffer);
  }

  function ensureClient() {
    return store.get("client_id").then(function (id) {
      if (id) return id;
      return http("POST", TPX + "/register", { "Content-Type": "application/json" }, JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      })).then(function (r) {
        if (!r.json || !r.json.client_id) throw new Error("client registration failed (" + r.status + ")");
        return store.set("client_id", r.json.client_id).then(function () { return r.json.client_id; });
      });
    });
  }

  function saveTokens(t) {
    var ops = [
      store.set("access_token", t.access_token),
      store.set("token_expiry", String(Date.now() + (t.expires_in || 3600) * 1000)),
    ];
    if (t.refresh_token) ops.push(store.set("refresh_token", t.refresh_token));
    return Promise.all(ops).then(function () { return t.access_token; });
  }

  function clearTokens() {
    return Promise.all([store.del("access_token"), store.del("token_expiry"), store.del("refresh_token")]);
  }

  function waitForCallback(state, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        window.removeEventListener("message", onMsg);
        reject(new Error("grant timed out — popup closed or blocked?"));
      }, timeoutMs);
      function onMsg(ev) {
        if (ev.origin !== SITE) return;
        if (!ev.data || ev.data.state !== state) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(ev.data);
      }
      window.addEventListener("message", onMsg);
    });
  }

  function interactiveGrant(clientId, status) {
    var budget = prompt("Grant budget for generation, in USD (metered, revocable at " + TPX + "/dashboard)", DEFAULT_BUDGET);
    if (!budget) return Promise.reject(new Error("grant cancelled"));
    var state = randomString();
    var verifier = randomString();
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (digest) {
      return http("POST", TPX + "/par", { "Content-Type": "application/x-www-form-urlencoded" }, form({
        client_id: clientId,
        response_type: "code",
        redirect_uri: CALLBACK,
        state: state,
        code_challenge: b64url(digest),
        code_challenge_method: "S256",
        authorization_details: JSON.stringify([{ type: "llm-inference", budget: parseFloat(budget) }]),
      }));
    }).then(function (r) {
      if (!r.json || !r.json.request_uri) throw new Error("PAR failed (" + r.status + "): " + r.text.slice(0, 120));
      status("approve the grant in the popup…");
      var url = TPX + "/authorize?client_id=" + encodeURIComponent(clientId) +
        "&request_uri=" + encodeURIComponent(r.json.request_uri);
      var popup = window.open(url, "om-tpx-grant", "width=480,height=640");
      if (!popup) throw new Error("popup blocked — allow popups for this site, then retry");
      return waitForCallback(state, 180000);
    }).then(function (cb) {
      if (cb.error) throw new Error("grant denied: " + (cb.error_description || cb.error));
      if (cb.iss && cb.iss !== TPX) throw new Error("authorization response from unexpected issuer");
      status("exchanging code…");
      return http("POST", TPX + "/token", { "Content-Type": "application/x-www-form-urlencoded" }, form({
        grant_type: "authorization_code",
        code: cb.code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      }));
    }).then(function (r) {
      if (!r.json || !r.json.access_token) throw new Error("token exchange failed (" + r.status + "): " + r.text.slice(0, 120));
      return saveTokens(r.json);
    });
  }

  function refreshGrant(clientId) {
    return store.get("refresh_token").then(function (rt) {
      if (!rt) return null;
      return http("POST", TPX + "/token", { "Content-Type": "application/x-www-form-urlencoded" }, form({
        grant_type: "refresh_token",
        refresh_token: rt,
        client_id: clientId,
      })).then(function (r) {
        if (!r.json || !r.json.access_token) return clearTokens().then(function () { return null; });
        return saveTokens(r.json);
      });
    });
  }

  function ensureToken(status) {
    return ensureClient().then(function (clientId) {
      return Promise.all([store.get("access_token"), store.get("token_expiry")]).then(function (vals) {
        if (vals[0] && Date.now() < parseInt(vals[1] || "0", 10) - 30000) return vals[0];
        status("refreshing TPX grant…");
        return refreshGrant(clientId).then(function (token) {
          return token || interactiveGrant(clientId, status);
        });
      });
    });
  }

  function ensureModel(force) {
    return store.get("model").then(function (model) {
      if (model && !force) return model;
      model = prompt("Model id to generate with (list: " + TPX + "/v1/models)", model || "llama-3.3-70b");
      if (!model) return null;
      model = model.trim();
      return store.set("model", model).then(function () { return model; });
    });
  }

  // ---- generation with page context -----------------------------------------

  var SYSTEM =
    "You write browser userscripts. Output ONLY JavaScript source code for a single userscript, with a standard metadata block:\n\n" +
    "// ==UserScript==\n" +
    "// @name         <short name>\n" +
    "// @description  <one line>\n" +
    "// @version      1.0.0\n" +
    "// @match        <derive a specific pattern from the target page URL>\n" +
    "// ==/UserScript==\n\n" +
    "You are given the target page's URL, title, and a sanitized excerpt of its HTML — use real selectors from it. " +
    "Rules: plain JavaScript (no build steps, no imports, no external script loading), operate only on the matched page's DOM, request no data from third-party servers unless the user's description explicitly requires it. Wrap logic in an IIFE. No explanation text before or after the code.";

  function pageContext() {
    var html = "";
    if (document.body) {
      var clone = document.body.cloneNode(true);
      var junk = clone.querySelectorAll("script,style,svg,noscript,iframe,link,meta");
      for (var i = 0; i < junk.length; i++) junk[i].remove();
      html = clone.innerHTML.replace(/\s+/g, " ").slice(0, 30000);
    }
    return "Target page URL: " + location.href +
      "\nTarget page title: " + document.title +
      "\n\nSanitized page HTML (truncated):\n" + html;
  }

  function stripFences(text) {
    var fenced = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
    return (fenced ? fenced[1] : text).trim();
  }

  function chat(token, model, messages) {
    return http("POST", TPX + "/v1/chat/completions", {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    }, JSON.stringify({ model: model, messages: messages, temperature: 0.4 }));
  }

  // ---- panel ----------------------------------------------------------------

  var panel = null;
  var draft = "";

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function openPanel() {
    if (panel) {
      panel.style.display = "";
      return;
    }
    panel = el("div",
      "position:fixed; bottom:16px; right:16px; z-index:2147483647; width:min(420px,92vw); max-height:80vh; overflow:auto;" +
      "background:#161b22; color:#e6edf3; border:1px solid #2d333b; border-radius:10px; padding:14px 16px;" +
      "font:14px/1.5 ui-sans-serif,system-ui,sans-serif; box-shadow:0 8px 32px rgba(0,0,0,0.5); text-align:left;");

    var head = el("div", "display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;");
    head.appendChild(el("strong", "", "openmonkey — script this page"));
    var close = el("a", "cursor:pointer; color:#9198a1; font-size:18px; text-decoration:none;", "×");
    close.addEventListener("click", function () { panel.style.display = "none"; });
    head.appendChild(close);

    var desc = el("textarea",
      "width:100%; box-sizing:border-box; min-height:64px; background:#0a0d12; color:#e6edf3; border:1px solid #2d333b;" +
      "border-radius:6px; padding:8px 10px; font:inherit; margin-bottom:8px;");
    desc.placeholder = "What should this page do differently? e.g. Hide the sidebar and widen the article";

    var row = el("p", "display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:0 0 8px;");
    var btn = el("button",
      "background:#3fb950; color:#04120a; font-weight:600; border:none; border-radius:6px; padding:6px 14px; cursor:pointer; font:inherit;",
      "Generate");
    var cog = el("a", "cursor:pointer; color:#9198a1; font-size:12px;", "⚙ model/grant");
    var out = el("span", "color:#9198a1; font-size:12px;");
    row.appendChild(btn); row.appendChild(cog); row.appendChild(out);

    var pre = el("pre",
      "display:none; background:#0a0d12; border:1px solid #2d333b; border-radius:6px; padding:8px; overflow:auto;" +
      "max-height:200px; font:11px/1.4 ui-monospace,Menlo,monospace; white-space:pre; margin:0 0 8px; text-align:left;");

    var row2 = el("p", "display:none; gap:10px; align-items:center; margin:0;");
    var pub = el("button",
      "background:#3fb950; color:#04120a; font-weight:600; border:none; border-radius:6px; padding:6px 14px; cursor:pointer; font:inherit;",
      "Publish to openmonkey");
    var discard = el("a", "cursor:pointer; color:#9198a1; font-size:12px;", "discard");
    row2.appendChild(pub); row2.appendChild(discard);

    var status = function (t) { out.textContent = t; };

    btn.addEventListener("click", function () {
      var request = desc.value.trim();
      if (!request) { status("describe the change first"); return; }
      var model;
      ensureModel(false).then(function (mod) {
        if (!mod) return;
        model = mod;
        btn.disabled = true;
        return ensureToken(status).then(function (token) {
          status("generating with " + model + "…");
          var messages = [
            { role: "system", content: SYSTEM },
            { role: "user", content: draft
              ? "Revise this userscript per the request below. Same output rules. Keep the metadata block, changing only what the request requires.\n\nRequest: " +
                request + "\n\n" + pageContext() + "\n\nCurrent script:\n" + draft
              : request + "\n\n" + pageContext() },
          ];
          return chat(token, model, messages).then(function (r) {
            if (r.status === 401 || r.status === 403) {
              return clearTokens().then(function () {
                return ensureToken(status).then(function (t2) { return chat(t2, model, messages); });
              });
            }
            return r;
          });
        }).then(function (r) {
          if (r.status >= 300) throw new Error("TPX " + r.status + ": " + r.text.slice(0, 160));
          var text = (r.json.choices && r.json.choices[0] && r.json.choices[0].message.content) || "";
          var code = stripFences(text);
          if (code.indexOf("==UserScript==") === -1)
            throw new Error("model did not return a userscript: " + text.slice(0, 120));
          draft = code;
          pre.textContent = code;
          pre.style.display = "";
          row2.style.display = "flex";
          btn.textContent = "Revise";
          status("review the code — publish, or describe another change");
          btn.disabled = false;
        });
      }).catch(function (e) {
        status(String((e && e.message) || e));
        btn.disabled = false;
      });
    });

    pub.addEventListener("click", function () {
      if (!draft) return;
      pub.disabled = true;
      status("publishing…");
      http("POST", API + "/scripts", { "Content-Type": "application/json" }, JSON.stringify({ code: draft }))
        .then(function (r) {
          if (r.status === 401) throw new Error("sign in at auth.proc.io in another tab, then publish again");
          if (r.status >= 300 || !r.json || !r.json.script)
            throw new Error("publish failed (" + ((r.json && r.json.error) || r.status) + ")");
          status("published — opening for install…");
          window.open(SITE + "/scripts/" + r.json.script.slug, "_blank");
          pub.disabled = false;
        })
        .catch(function (e) {
          status(String((e && e.message) || e));
          pub.disabled = false;
        });
    });

    discard.addEventListener("click", function () {
      draft = "";
      pre.style.display = "none";
      pre.textContent = "";
      row2.style.display = "none";
      btn.textContent = "Generate";
      status("");
    });

    cog.addEventListener("click", function () {
      ensureModel(true).then(function () {
        if (confirm("Also revoke the cached TPX grant on this device? (A new budget approval will be requested on next generation.)")) {
          clearTokens().then(function () { status("grant cleared"); });
        }
      });
    });

    panel.appendChild(head);
    panel.appendChild(desc);
    panel.appendChild(row);
    panel.appendChild(pre);
    panel.appendChild(row2);
    document.documentElement.appendChild(panel);
    desc.focus();
  }

  // ---- trigger: manager menu command, floating button as fallback -----------

  if (gm && typeof gm.registerMenuCommand === "function") {
    gm.registerMenuCommand("openmonkey: script this page…", openPanel);
  } else {
    var fab = el("div",
      "position:fixed; bottom:16px; right:16px; z-index:2147483646; width:34px; height:34px; border-radius:50%;" +
      "background:#161b22; border:1px solid #2d333b; display:flex; align-items:center; justify-content:center;" +
      "cursor:pointer; opacity:0.55; font-size:17px; user-select:none;", "🐵");
    fab.title = "openmonkey: script this page";
    fab.addEventListener("mouseenter", function () { fab.style.opacity = "1"; });
    fab.addEventListener("mouseleave", function () { fab.style.opacity = "0.55"; });
    fab.addEventListener("click", openPanel);
    var addFab = function () { document.documentElement.appendChild(fab); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addFab);
    else addFab();
  }
})();
