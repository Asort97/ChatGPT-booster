/**
 * ChatGPT Speed Booster - fetch interceptor (MAIN world).
 *
 * Runs at document_start in the page's JS context. Patches window.fetch so
 * that the GET /backend-api/conversation/<id> response is trimmed *before*
 * React ever sees it. ChatGPT's framework therefore only constructs DOM for
 * the kept messages — long chats render instantly.
 *
 * Settings come from localStorage (written by the ISOLATED-world content
 * script via the same origin's storage).
 *
 * Strategy port from Noah4ever/ai-chat-speed-booster (MIT) and the
 * conversation tree shape used by ChatGPT.
 */
(function () {
  "use strict";

  if (window.__SB_FETCH_PATCHED__) return;
  window.__SB_FETCH_PATCHED__ = true;

  const SETTINGS_KEY = "sb_fetch_settings";
  const TRIMMED_ATTR = "data-sb-trimmed";
  const BYPASS_KEY = "sb_skip_trim_once";

  const URL_MATCH = "/backend-api/conversation/";
  const URL_EXCLUDE = ["/backend-api/conversations"];
  const VISIBLE_ROLES = ["user", "assistant", "tool"];
  // keep some headroom so "load older" reveals more without a full reload
  const BUFFER_MULTIPLIER = 4;
  // each visible turn ≈ 2 API messages (user + assistant)
  const API_PER_TURN = 2;

  const DEFAULTS = { enabled: true, visibleMessages: 15 };

  function readSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          enabled: parsed.enabled !== false,
          visibleMessages: clamp(parsed.visibleMessages || DEFAULTS.visibleMessages, 1, 200),
        };
      }
    } catch (_) {
      /* ignore */
    }
    return { ...DEFAULTS };
  }

  function clamp(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function shouldIntercept(url, method) {
    if (method !== "GET") return false;
    if (!url.includes(URL_MATCH)) return false;
    for (const ex of URL_EXCLUDE) if (url.includes(ex)) return false;
    return true;
  }

  function isVisibleNode(node) {
    if (!node || !node.message) return false;
    const role = node.message.author && node.message.author.role;
    return typeof role === "string" && VISIBLE_ROLES.includes(role);
  }

  function trimTree(data, limit) {
    const mapping = data && data.mapping;
    const currentNodeId = data && data.current_node;
    if (!mapping || !currentNodeId || !mapping[currentNodeId]) return null;

    // Walk current_node -> root via parent pointers.
    const chain = [];
    const visited = new Set();
    let nid = currentNodeId;
    while (nid && mapping[nid] && !visited.has(nid)) {
      visited.add(nid);
      chain.push(nid);
      nid = mapping[nid].parent || null;
    }
    chain.reverse();

    let totalVisible = 0;
    for (const id of chain) if (isVisibleNode(mapping[id])) totalVisible++;
    if (totalVisible <= limit) return null;

    // Find cutoff index: keep only the last `limit` visible messages.
    let count = 0;
    let cutoff = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (isVisibleNode(mapping[chain[i]])) {
        count++;
        if (count >= limit) {
          cutoff = i;
          break;
        }
      }
    }

    // Keep system/metadata (non-visible) nodes before cutoff so the chain
    // stays valid; keep everything from cutoff onwards.
    const kept = new Set();
    for (let i = 0; i < cutoff; i++) {
      if (!isVisibleNode(mapping[chain[i]])) kept.add(chain[i]);
    }
    for (let i = cutoff; i < chain.length; i++) kept.add(chain[i]);

    const keptChain = chain.filter((id) => kept.has(id));

    // Rebuild mapping with reconnected pointers (deep-cloned to avoid
    // mutating the original parsed JSON in case caller still references it).
    const newMapping = {};
    for (let i = 0; i < keptChain.length; i++) {
      const id = keptChain[i];
      const node = JSON.parse(JSON.stringify(mapping[id]));
      node.parent = i > 0 ? keptChain[i - 1] : null;
      node.children = i < keptChain.length - 1 ? [keptChain[i + 1]] : [];
      newMapping[id] = node;
    }

    const result = Object.assign({}, data);
    result.mapping = newMapping;
    return result;
  }

  function buildResponse(original, body) {
    const headers = new Headers(original.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.delete("content-length");
    headers.delete("content-encoding");
    const res = new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers,
    });
    try {
      Object.defineProperty(res, "url", { value: original.url });
    } catch (_) {
      /* ignore */
    }
    return res;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    let url;
    let method;
    try {
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.toString();
      else if (input && typeof input.url === "string") url = input.url;
      else url = String(input);
      method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    } catch (_) {
      return originalFetch(input, init);
    }

    if (!shouldIntercept(url, method)) return originalFetch(input, init);

    const settings = readSettings();
    if (!settings.enabled) return originalFetch(input, init);

    // One-shot bypass (e.g. user clicked "load full conversation").
    try {
      if (localStorage.getItem(BYPASS_KEY) === "1") {
        localStorage.removeItem(BYPASS_KEY);
        document.documentElement.removeAttribute(TRIMMED_ATTR);
        return originalFetch(input, init);
      }
    } catch (_) {
      /* ignore */
    }

    const fetchLimit = settings.visibleMessages * API_PER_TURN * BUFFER_MULTIPLIER;

    let response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      throw err;
    }
    if (!response || !response.ok) return response;

    try {
      const clone = response.clone();
      let text = await clone.text();
      if (!text) return response;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        return response;
      }

      const trimmed = trimTree(data, fetchLimit);
      if (!trimmed) return response;

      try {
        document.documentElement.setAttribute(TRIMMED_ATTR, "1");
      } catch (_) {
        /* ignore */
      }
      return buildResponse(response, JSON.stringify(trimmed));
    } catch (err) {
      return response;
    }
  };

  // Expose minimal API for the ISOLATED-world content script to push settings.
  window.__SB_PUSH_SETTINGS__ = function (settings) {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          enabled: settings && settings.enabled !== false,
          visibleMessages: clamp(
            (settings && settings.visibleMessages) || DEFAULTS.visibleMessages,
            1,
            200,
          ),
        }),
      );
    } catch (_) {
      /* ignore */
    }
  };

  window.__SB_REQUEST_FULL_RELOAD__ = function () {
    try {
      localStorage.setItem(BYPASS_KEY, "1");
    } catch (_) {
      /* ignore */
    }
    location.reload();
  };
})();
