// ==UserScript==
// @name         openmonkey scanner (TPX)
// @description  Adds a "Scan with my model" button to openmonkey script pages. Audits the exact source through a metered TPX grant you approve (OAuth, no API keys) and publishes the verdict to the registry.
// @version      2.0.0
// @match        https://openmonkey.proc.io/scripts/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @connect      api.tokenpony.dev
// ==/UserScript==
(function () {
  "use strict";

  var API = "https://api.openmonkey.proc.io/api";
  var TPX = "https://api.tokenpony.dev";
  var CALLBACK = "https://openmonkey.proc.io/oauth/tpx";
  var CLIENT_NAME = "openmonkey scanner (TPX)";
  var DEFAULT_BUDGET = "0.25";

  var m = location.pathname.match(/^\/scripts\/([a-z0-9-]+)$/);
  if (!m) return; // list page or raw .user.js — nothing to do
  var slug = m[1];

  // ---- storage (GM with localStorage fallback) ------------------------------

  var gm = typeof GM !== "undefined" ? GM : null;
  var store = {
    get: function (k) {
      return gm && gm.getValue ? gm.getValue(k) : Promise.resolve(localStorage.getItem("om_scan_" + k));
    },
    set: function (k, v) {
      return gm && gm.setValue ? gm.setValue(k, v) : Promise.resolve(localStorage.setItem("om_scan_" + k, v));
    },
    del: function (k) {
      return gm && gm.deleteValue ? gm.deleteValue(k) : Promise.resolve(localStorage.removeItem("om_scan_" + k));
    },
  };

  // ---- tiny HTTP helper (GM.xmlHttpRequest bypasses CORS) -------------------

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
    return fetch(url, { method: method, headers: headers, body: body }).then(function (r) {
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

  // Wait for the /oauth/tpx relay page to deposit {code,state} in localStorage.
  function waitForCallback(state, timeoutMs) {
    var key = "om_tpx_cb_" + state;
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + timeoutMs;
      var timer = setInterval(function () {
        var raw = localStorage.getItem(key);
        if (raw) {
          clearInterval(timer);
          localStorage.removeItem(key);
          resolve(JSON.parse(raw));
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("grant timed out — popup closed or blocked?"));
        }
      }, 400);
    });
  }

  function interactiveGrant(clientId, status) {
    var budget = prompt("Grant budget for scans, in USD (metered, revocable at " + TPX + "/dashboard)", DEFAULT_BUDGET);
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
      if (!popup) throw new Error("popup blocked — allow popups for this site");
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
        // Refresh tokens rotate on every use; a failed refresh means the old
        // token is dead, so drop everything and fall back to a fresh grant.
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

  // ---- model choice ---------------------------------------------------------

  function ensureModel(force) {
    return store.get("model").then(function (model) {
      if (model && !force) return model;
      model = prompt("Model id to scan with (list: " + TPX + "/v1/models)", model || "llama-3.3-70b");
      if (!model) return null;
      model = model.trim();
      return store.set("model", model).then(function () { return model; });
    });
  }

  // ---- the scan -------------------------------------------------------------

  var SYSTEM =
    'You are auditing a browser userscript before a human runs it. Judge only the code given.\n' +
    'Respond with ONLY a JSON object: {"verdict":"pass|warn|fail","summary":"at most two sentences"}.\n' +
    "fail: exfiltrates data or credentials, injects hidden remote code, manipulates accounts or payments, or hides behavior (obfuscation plus network calls).\n" +
    "warn: overly broad @match, fetches remote code or config, collects more data than its stated purpose needs, or is too obfuscated to be sure.\n" +
    "pass: does what its metadata says with no meaningful risk.";

  function chat(token, model, messages) {
    return http("POST", TPX + "/v1/chat/completions", {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    }, JSON.stringify({ model: model, messages: messages, temperature: 0 }));
  }

  function scan(btn, status) {
    var model, version;
    return ensureModel(false).then(function (mod) {
      if (!mod) return;
      model = mod;
      btn.disabled = true;
      return ensureToken(status).then(function (token) {
        status("fetching source…");
        return fetch(API + "/scripts/" + slug).then(function (r) {
          if (!r.ok) throw new Error("could not fetch script (" + r.status + ")");
          return r.json();
        }).then(function (data) {
          version = data.version;
          status("scanning v" + version.version + " with " + model + "…");
          return chat(token, model, [
            { role: "system", content: SYSTEM },
            { role: "user", content: "Script: " + data.script.name + "\n\n" + version.code },
          ]);
        }).then(function (r) {
          if (r.status === 401 || r.status === 403) {
            // token expired or budget exhausted — re-grant once and retry
            return clearTokens().then(function () {
              return ensureToken(status).then(function (t2) {
                return chat(t2, model, [
                  { role: "system", content: SYSTEM },
                  { role: "user", content: "Script: " + slug + "\n\n" + version.code },
                ]);
              });
            });
          }
          return r;
        }).then(function (r) {
          if (r.status >= 300) throw new Error("TPX " + r.status + ": " + r.text.slice(0, 160));
          var text = (r.json.choices && r.json.choices[0] && r.json.choices[0].message.content) || "";
          var match = text.match(/\{[\s\S]*\}/);
          var verdict = match ? JSON.parse(match[0]) : {};
          if (["pass", "warn", "fail"].indexOf(verdict.verdict) === -1)
            throw new Error("unparseable verdict: " + text.slice(0, 120));
          status("publishing " + verdict.verdict + " verdict…");
          return fetch(API + "/versions/" + version.id + "/scans", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ verdict: verdict.verdict, summary: verdict.summary, model: model + " (TPX grant)" }),
          });
        }).then(function (pub) {
          if (pub.status === 401) throw new Error("sign in at auth.proc.io first, then retry");
          if (!pub.ok) throw new Error("verdict publish failed (" + pub.status + ")");
          location.reload();
        });
      });
    }).catch(function (e) {
      status(String((e && e.message) || e));
      btn.disabled = false;
    });
  }

  // ---- UI -------------------------------------------------------------------

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
    cog.textContent = "⚙ model/grant";
    cog.className = "muted";
    var out = document.createElement("span");
    out.className = "muted";
    var status = function (t) { out.textContent = t; };
    btn.addEventListener("click", function () { scan(btn, status); });
    cog.addEventListener("click", function (e) {
      e.preventDefault();
      ensureModel(true).then(function () {
        if (confirm("Also revoke the cached TPX grant on this device? (A new budget approval will be requested on next scan.)")) {
          clearTokens().then(function () { status("grant cleared"); });
        }
      });
    });
    row.appendChild(btn);
    row.appendChild(cog);
    row.appendChild(out);
    heading.parentNode.insertBefore(row, heading.nextSibling);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
