// Browser-side TPX client (OAuth 2.1 public client + defense chat), served
// at GET /tpx.js and shared by the spec page and the /tpx/callback page.
// Kept as one plain-string module so there is no build step; the client code
// deliberately avoids template literals so this file needs no escaping.
//
// Conformance (tokenpony.dev/llms.txt, spec section 12): RFC 9728 + 8414
// discovery of a user-chosen provider, PKCE S256 (via PAR when the provider
// offers it), iss + state validation on the callback, exact redirect_uri
// from the server-cached registration, budgets requested and read back via
// authorization_details, refresh on 401, re-authorize on invalid_grant.
// DPoP (a SHOULD) is deliberately skipped in v1.

export const TPX_JS = `(() => {
  "use strict";
  const DEFAULT_PROVIDER = {
    issuer: "https://api.tokenpony.dev",
    resource: "https://api.tokenpony.dev",
    authorization_endpoint: "https://api.tokenpony.dev/authorize",
    token_endpoint: "https://api.tokenpony.dev/token",
    par_endpoint: "https://api.tokenpony.dev/par",
    revocation_endpoint: "https://api.tokenpony.dev/revoke",
  };
  const DEFAULT_MODEL = "kimi-k2.7-code";
  const DEFAULT_BUDGET = 0.25;
  const MAX_TURNS = 12; // resent per request, plus the system prompt
  const K = { tokens: "tpx.tokens", spent: "tpx.spent", model: "tpx.model",
    provider: "tpx.provider", lock: "tpx.refresh_lock", pkce: "tpx.pkce" };

  // ---------- utils ----------
  const loadJson = (store, key) => {
    try { const v = store.getItem(key); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  };
  const saveJson = (store, key, v) => store.setItem(key, JSON.stringify(v));
  const b64url = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
  };
  const randB64url = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeS256 = async (verifier) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(d));
  };
  const usd = (n) => {
    const v = Math.round(n * 1e6) / 1e6;
    return "$" + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2));
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const stripSlash = (s) => s.replace(/[/]+$/, "");

  // ---------- provider discovery (RFC 9728 then RFC 8414) ----------
  async function discoverProvider(input) {
    let base;
    try { base = new URL(String(input).trim()).origin; }
    catch (e) { throw new Error("enter the provider origin, e.g. https://api.tokenpony.dev"); }
    let resource = base;
    let as = base;
    try {
      const pr = await (await fetch(base + "/.well-known/oauth-protected-resource")).json();
      if (pr && typeof pr.resource === "string") resource = stripSlash(pr.resource);
      if (pr && Array.isArray(pr.authorization_servers) && pr.authorization_servers[0]) {
        as = stripSlash(pr.authorization_servers[0]);
      }
    } catch (e) { /* the provider may be the authorization server itself */ }
    const res = await fetch(as + "/.well-known/oauth-authorization-server");
    if (!res.ok) throw new Error("provider discovery failed (" + res.status + ")");
    const meta = await res.json();
    const types = meta.authorization_details_types_supported;
    if (!Array.isArray(types) || types.indexOf("llm-inference") < 0) {
      throw new Error("this provider does not support TPX llm-inference grants");
    }
    if (!meta.issuer || !meta.authorization_endpoint || !meta.token_endpoint) {
      throw new Error("provider metadata is incomplete");
    }
    return {
      issuer: stripSlash(meta.issuer),
      resource: resource,
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      par_endpoint: meta.pushed_authorization_request_endpoint || null,
      revocation_endpoint: meta.revocation_endpoint || null,
    };
  }

  // ---------- client registration (server-cached, per provider) ----------
  async function getClient(refresh, issuer) {
    const res = await fetch("/tpx/client?issuer=" + encodeURIComponent(issuer) +
      (refresh ? "&refresh=1" : ""));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error === "not_a_tpx_provider"
        ? "this provider does not speak TPX"
        : "provider registration unavailable; try again in a minute");
    }
    return body;
  }

  // ---------- tokens ----------
  const getTokens = () => loadJson(localStorage, K.tokens);
  const setTokens = (t) => saveJson(localStorage, K.tokens, t);
  // Tokens minted before provider support carry no provider block.
  const providerOf = (t) => (t && t.provider) || DEFAULT_PROVIDER;
  const getSpent = () => Number(localStorage.getItem(K.spent) || "0");
  const addSpent = (cost) =>
    localStorage.setItem(K.spent, String(getSpent() + cost));
  const clearGrant = () => {
    localStorage.removeItem(K.tokens);
    localStorage.removeItem(K.spent);
  };
  const grantGone = () => {
    const e = new Error("grant expired or revoked");
    e.grantGone = true;
    return e;
  };

  async function tokenRequest(endpoint, params) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(body.error_description || body.error || ("token endpoint " + res.status));
      e.code = body.error;
      throw e;
    }
    return body;
  }

  function storeTokenResponse(body, fallbackBudget, provider) {
    const details = Array.isArray(body.authorization_details)
      ? body.authorization_details.find((d) => d && d.type === "llm-inference")
      : null;
    setTokens({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      // The granted budget can be lower than requested; always display this.
      budget: details && typeof details.budget === "number" ? details.budget : fallbackBudget,
      expires_at: Date.now() + ((body.expires_in || 3600) - 300) * 1000,
      provider: provider,
    });
  }

  // Refresh tokens ROTATE on every use, and reusing a rotated one revokes
  // the grant — so store the new pair immediately, and use a best-effort
  // localStorage lock so two tabs rarely race. A lost race degrades to the
  // re-grant CTA, never a broken page.
  let refreshing = null;
  function refreshTokens() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => { refreshing = null; });
    }
    return refreshing;
  }
  async function doRefresh() {
    const lock = Number(localStorage.getItem(K.lock) || "0");
    if (Date.now() - lock < 15000) {
      await new Promise((r) => setTimeout(r, 1500));
      const t = getTokens();
      if (t && Date.now() < t.expires_at) return t; // another tab already rotated
    }
    localStorage.setItem(K.lock, String(Date.now()));
    try {
      const t = getTokens();
      if (!t || !t.refresh_token) throw grantGone();
      const p = providerOf(t);
      const client = await getClient(false, p.issuer);
      const body = await tokenRequest(p.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: client.client_id,
      });
      storeTokenResponse(body, t.budget, p);
      return getTokens();
    } catch (e) {
      if (e.code === "invalid_grant") { clearGrant(); throw grantGone(); }
      throw e;
    } finally {
      localStorage.removeItem(K.lock);
    }
  }

  async function tpxFetch(path, init) {
    let t = getTokens();
    if (!t) throw grantGone();
    if (Date.now() >= t.expires_at) t = await refreshTokens();
    const withAuth = (tok) => {
      const headers = Object.assign({}, (init && init.headers) || {},
        { Authorization: "Bearer " + tok.access_token });
      return fetch(providerOf(tok).resource + path, Object.assign({}, init, { headers: headers }));
    };
    let res = await withAuth(t);
    if (res.status === 401) {
      t = await refreshTokens();
      res = await withAuth(t);
      if (res.status === 401) { clearGrant(); throw grantGone(); }
    }
    return res;
  }

  // ---------- grant flow ----------
  async function startGrant(budget, providerInput) {
    budget = Math.max(0.01, Math.round(budget * 1e6) / 1e6);
    const p = await discoverProvider(providerInput);
    localStorage.setItem(K.provider, p.issuer);
    let client = await getClient(false, p.issuer);
    const verifier = randB64url();
    const state = randB64url();
    saveJson(sessionStorage, K.pkce,
      { verifier: verifier, state: state, return_to: location.pathname, provider: p });
    const params = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uri,
      code_challenge: await challengeS256(verifier),
      code_challenge_method: "S256",
      state: state,
      resource: p.resource,
      authorization_details: JSON.stringify([{ type: "llm-inference", budget: budget }]),
    };
    if (!p.par_endpoint) {
      // Providers without PAR get the plain RFC 6749 front-channel request.
      location.href = p.authorization_endpoint + "?" + new URLSearchParams(params);
      return;
    }
    const par = (q) => fetch(p.par_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(q),
    });
    let res = await par(params);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.error === "invalid_client") {
        // The provider no longer knows our registration; re-register, retry.
        client = await getClient(true, p.issuer);
        params.client_id = client.client_id;
        params.redirect_uri = client.redirect_uri;
        res = await par(params);
      }
      if (!res.ok) {
        const b2 = await res.json().catch(() => ({}));
        throw new Error(b2.error_description || b2.error || "authorization request failed");
      }
    }
    const out = await res.json();
    // request_uri expires in ~90s, which is why it is minted on click only.
    location.href = p.authorization_endpoint + "?client_id=" +
      encodeURIComponent(params.client_id) +
      "&request_uri=" + encodeURIComponent(out.request_uri);
  }

  // ---------- callback page ----------
  async function runCallback() {
    const status = document.getElementById("tpx-cb-status");
    const q = new URLSearchParams(location.search);
    const pkce = loadJson(sessionStorage, K.pkce);
    sessionStorage.removeItem(K.pkce); // codes are single-use; so is our state
    const backTo = (pkce && pkce.return_to) || "/hub";
    const fail = (msg) => {
      status.textContent = msg + " ";
      const a = el("a", "", "Back to the spec");
      a.href = backTo;
      status.appendChild(a);
    };
    if (q.get("error")) {
      return fail("The provider declined: " + (q.get("error_description") || q.get("error")) + ".");
    }
    if (!pkce) {
      return fail("This response doesn't match a grant started in this tab; start again.");
    }
    const p = pkce.provider || DEFAULT_PROVIDER;
    // RFC 9207: the response must name the issuer the flow started with.
    if (q.get("iss") !== p.issuer) return fail("Issuer mismatch; refusing to continue.");
    if (q.get("state") !== pkce.state) return fail("State mismatch; refusing to continue.");
    const code = q.get("code");
    if (!code) return fail("Missing authorization code.");
    try {
      const client = await getClient(false, p.issuer);
      const body = await tokenRequest(p.token_endpoint, {
        grant_type: "authorization_code",
        code: code,
        redirect_uri: client.redirect_uri,
        client_id: client.client_id,
        code_verifier: pkce.verifier,
      });
      storeTokenResponse(body, 0, p);
      localStorage.setItem(K.spent, "0");
      location.replace(backTo);
    } catch (e) {
      fail("Code exchange failed (" + e.message + "); codes expire in 5 minutes, start again.");
    }
  }

  // ---------- defense chat ----------
  function systemPrompt(ctx) {
    const latest = ctx.history && ctx.history[0];
    const parts = [
      'You are the author of the TLA+ specification "' + ctx.name + '", and you are ' +
      "defending it at a dissertation defense. The questioner is a committee member. " +
      "Answer in the first person, as the author: explain and defend your design " +
      "decisions with rigor, cite specific definitions, actions, and invariants from " +
      "the spec by name, and use the changelog history to explain how the design " +
      "evolved and why.",
      "",
      "Be honest about scope. This spec was verified with a finite model checker in " +
      "its safety subset only: small CONSTANT sets, invariant checking, [][A]_v " +
      "action properties, and deadlock detection. It proves nothing about liveness, " +
      "fairness, or unbounded instances. If a question exposes a genuine gap or a " +
      "limitation of the model, concede it plainly and say what the next generation " +
      "of the spec would change; a good defense admits the boundaries of its claims.",
      "",
      "Keep answers focused: a few tight paragraphs, mathematical when useful, never " +
      "bluffing beyond what the spec supports.",
      "",
      "=== DESCRIPTION ===",
      ctx.description || "(none provided)",
      "",
      "=== " + ctx.name + ".tla" + (ctx.truncated ? " (truncated)" : "") + " ===",
      ctx.tla,
      "",
      "=== " + ctx.name + ".cfg ===",
      ctx.cfg,
      "",
      "=== CHECK RESULTS (generation " + ctx.gen + ") ===",
      "distinct states: " + ((latest && latest.distinctStates) || "unknown") +
      " / depth: " + ((latest && latest.depth) || "unknown") +
      " / generations published: " + ctx.generations + ", every one passed the checker",
      "",
      "=== CHANGELOG HISTORY (newest first) ===",
    ];
    for (const h of ctx.history || []) {
      parts.push("gen " + h.gen + " (" + h.createdAt + "): " + (h.changelog || "(no changelog)"));
    }
    if (ctx.wins && ctx.wins.length) {
      parts.push("", "=== WINS (design bugs the checker caught) ===");
      for (const w of ctx.wins) {
        parts.push(
          w.title + (w.invariant ? " [" + w.invariant + "]" : "") +
          " (fixed in gen " + w.gen + "): " + w.story,
        );
      }
      parts.push(
        "Cite these wins when defending the value of the modeling effort; they are " +
        "concrete cases where checking changed the design.",
      );
    }
    return parts.join("\\n");
  }

  async function loadModels(resource) {
    try {
      const res = await fetch(resource + "/models");
      const body = await res.json();
      return (body.data || []).map((m) => m.id);
    } catch (e) {
      return [DEFAULT_MODEL];
    }
  }

  function initChat(root, ctx) {
    const provider = providerOf(getTokens());
    const turns = []; // {role, content} excluding the system prompt
    let streaming = null; // AbortController while a reply streams

    root.textContent = "";
    const meta = el("div", "chat-meta");
    const budgetLine = el("span");
    const provLine = el("span", "dim", "via " + new URL(provider.resource).host);
    const modelSel = document.createElement("select");
    const revokeBtn = el("button", "plain", "Revoke grant");
    const log = el("div", "chat-log");
    const err = el("p", "chat-err");
    const row = el("div", "chat-row");
    const input = document.createElement("textarea");
    input.placeholder = "Ask the author to defend a design decision\\u2026";
    input.rows = 2;
    const sendBtn = el("button", "", "Ask");
    row.append(input, sendBtn);
    meta.append(budgetLine, provLine, modelSel, revokeBtn);
    root.append(meta, log, err, row);

    loadModels(provider.resource).then((ids) => {
      const saved = localStorage.getItem(K.model);
      for (const id of ids) {
        const o = document.createElement("option");
        o.value = o.textContent = id;
        modelSel.appendChild(o);
      }
      modelSel.value = ids.includes(saved) ? saved
        : ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids[0];
    });
    modelSel.addEventListener("change", () => localStorage.setItem(K.model, modelSel.value));

    const updateBudgetLine = () => {
      const t = getTokens();
      budgetLine.textContent = t
        ? "spent " + usd(getSpent()) + " of " + usd(t.budget) + " granted"
        : "";
    };
    updateBudgetLine();
    window.addEventListener("storage", updateBudgetLine);

    const bubble = (who, cls) => {
      const wrap = el("div", "chat-msg " + cls);
      wrap.appendChild(el("span", "who", who));
      const text = el("div", "text");
      wrap.appendChild(text);
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
      return text;
    };

    const showError = (e) => {
      err.textContent = e && e.message ? e.message : String(e);
    };
    const regrantCta = (label) => {
      err.textContent = label + " ";
      const b = el("button", "plain", "Grant a new budget");
      b.addEventListener("click", () => renderGrantForm(root, ctx));
      err.appendChild(b);
    };

    revokeBtn.addEventListener("click", async () => {
      const t = getTokens();
      const p = providerOf(t);
      if (t && t.refresh_token && p.revocation_endpoint) {
        try {
          const client = await getClient(false, p.issuer);
          await fetch(p.revocation_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: t.refresh_token,
              token_type_hint: "refresh_token",
              client_id: client.client_id,
            }),
          });
        } catch (e) { /* revocation is best-effort */ }
      }
      clearGrant();
      renderGrantForm(root, ctx);
    });

    async function send() {
      if (streaming) { streaming.abort(); return; }
      const content = input.value.trim();
      if (!content) return;
      err.textContent = "";
      input.value = "";
      bubble("you", "user").textContent = content;
      turns.push({ role: "user", content: content });
      const messages = [{ role: "system", content: systemPrompt(ctx) }]
        .concat(turns.slice(-MAX_TURNS));
      const out = bubble(ctx.name + " (author)", "assistant");
      out.textContent = "\\u2026";

      streaming = new AbortController();
      sendBtn.textContent = "Stop";
      try {
        const res = await tpxFetch("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: modelSel.value || DEFAULT_MODEL,
            messages: messages,
            stream: true,
            max_tokens: 1024,
          }),
          signal: streaming.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const code = body.error && body.error.code;
          out.parentNode.remove();
          turns.pop();
          input.value = content; // let the user retry without retyping
          if (res.status === 402 && code === "budget_exhausted") {
            return regrantCta("Budget spent (" + usd(getSpent()) + ").");
          }
          if (res.status === 402 && code === "balance_exhausted") {
            err.textContent = "Your provider balance is empty; top it off at " +
              new URL(provider.resource).host + ".";
            return;
          }
          if (code === "model_not_permitted" || code === "model_not_found") {
            return showError(new Error("This grant can't use " + modelSel.value + "; pick another model."));
          }
          return showError(new Error((body.error && body.error.message) || code || ("request failed (" + res.status + ")")));
        }

        // SSE: buffer by blank-line-delimited events; every parsed chunk is
        // checked for usage.cost (the exact USD charge arrives in the final
        // chunk, before or after [DONE] depending on the provider).
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        let text = "";
        let done = false;
        const handleEvent = (event) => {
          const data = event.split("\\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\\n");
          if (!data) return;
          if (data === "[DONE]") { done = true; return; }
          let chunk;
          try { chunk = JSON.parse(data); } catch (e) { return; }
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (delta && typeof delta.content === "string") {
            text += delta.content;
            out.textContent = text;
            log.scrollTop = log.scrollHeight;
          }
          if (chunk.usage && typeof chunk.usage.cost === "number") {
            addSpent(chunk.usage.cost);
            updateBudgetLine();
          }
        };
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          buf = buf.replace(/\\r\\n/g, "\\n");
          let idx;
          while ((idx = buf.indexOf("\\n\\n")) >= 0) {
            handleEvent(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
          if (done) break;
        }
        buf += decoder.decode();
        if (buf.trim()) handleEvent(buf);
        if (!text) out.textContent = "(empty reply)";
        turns.push({ role: "assistant", content: text });
      } catch (e) {
        if (e.name === "AbortError") {
          if (out.textContent === "\\u2026") out.parentNode.remove();
          else turns.push({ role: "assistant", content: out.textContent });
        } else if (e.grantGone) {
          out.parentNode.remove();
          turns.pop();
          input.value = content;
          regrantCta("Your grant has expired or been revoked.");
        } else {
          out.parentNode.remove();
          turns.pop();
          input.value = content;
          showError(e);
        }
      } finally {
        streaming = null;
        sendBtn.textContent = "Ask";
      }
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  function renderGrantForm(root, ctx) {
    root.textContent = "";
    const p = el("p", "", "Grant a small budget from a TPX provider to question the author. " +
      "The grant is revocable, capped, and carries no identity.");
    const provRow = el("div", "chat-row");
    const provLabel = el("span", "dim", "provider");
    const prov = document.createElement("input");
    prov.type = "url";
    prov.placeholder = DEFAULT_PROVIDER.issuer;
    prov.value = localStorage.getItem(K.provider) || DEFAULT_PROVIDER.issuer;
    provRow.append(provLabel, prov);
    const row = el("div", "chat-row");
    const amountLabel = el("span", "dim", "budget $");
    const amount = document.createElement("input");
    amount.type = "number";
    amount.min = "0.01";
    amount.step = "0.01";
    amount.value = String(DEFAULT_BUDGET);
    amount.style.width = "6rem";
    const go = el("button", "", "Grant & start");
    const err = el("p", "chat-err");
    row.append(amountLabel, amount, go);
    root.append(p, provRow, row, err);
    go.addEventListener("click", async () => {
      go.disabled = true;
      err.textContent = "";
      try {
        await startGrant(Number(amount.value) || DEFAULT_BUDGET,
          prov.value || DEFAULT_PROVIDER.issuer);
      } catch (e) {
        go.disabled = false;
        err.textContent = e && e.message ? e.message : String(e);
      }
    });
  }

  // ---------- entry ----------
  if (document.getElementById("tpx-callback")) {
    runCallback();
    return;
  }
  const ctxEl = document.getElementById("spec-context");
  const root = document.getElementById("tpx-defense");
  if (!ctxEl || !root) return;
  let ctx;
  try { ctx = JSON.parse(ctxEl.textContent); } catch (e) { return; }
  if (getTokens()) initChat(root, ctx);
  else renderGrantForm(root, ctx);
})();
`;
