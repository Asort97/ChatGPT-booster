/**
 * ChatGPT Speed Booster - ISOLATED-world content script.
 *
 * Two responsibilities:
 *   1. Keep the page-script's localStorage-backed settings in sync with the
 *      extension's chrome.storage. The page-script (MAIN world) reads these
 *      to decide whether/how to trim API responses before React sees them.
 *   2. Provide a DOM-level fallback "keep-last-N" trim, in case ChatGPT ever
 *      loads messages bypassing the intercepted /backend-api/conversation/
 *      endpoint (paginated history, hot-reload SPA navigation, etc).
 *   3. Answer the popup's getStats / updateConfig messages.
 */

(function () {
  "use strict";

  const TURN_SELECTOR_STRATEGIES = [
    '[data-testid^="conversation-turn-"]',
    'article[data-message-id]',
    'main article',
    'div[data-message-author-role]',
  ];
  const VID_ATTR = "data-sb-vid";
  const LOAD_BTN_ID = "speed-booster-load-older";
  const STYLE_ID = "speed-booster-style";
  const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
  const SETTINGS_KEY = "sb_fetch_settings";
  const TRIMMED_ATTR = "data-sb-trimmed";
  const BYPASS_KEY = "sb_skip_trim_once";

  const DEFAULTS = { enabled: true, visibleMessages: 15 };

  const LOAD_BATCH_SIZE = 10;
  const MUTATION_DEBOUNCE_MS = 150;
  const URL_CHECK_INTERVAL = 1000;
  const BOOT_DELAY_MS = 800;

  // Detached turns in oldest -> newest order.
  const detached = [];

  const state = {
    enabled: true,
    visibleMessages: DEFAULTS.visibleMessages,
    nextVid: 1,
    observer: null,
    lastUrl: location.href,
    mutationTimer: null,
    booted: false,
    suppressMutations: false,
    stats: { total: 0, rendered: 0 },
  };

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function normalizeConfig(raw) {
    return {
      enabled: raw && raw.enabled !== false,
      visibleMessages: clamp((raw && raw.visibleMessages) || DEFAULTS.visibleMessages, 1, 200),
    };
  }

  function syncToPageScript(cfg) {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          enabled: cfg.enabled,
          visibleMessages: cfg.visibleMessages,
        }),
      );
    } catch (_) {
      /* ignore */
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" + LOAD_BTN_ID + "{display:block;margin:16px auto;padding:8px 16px;" +
      "background:rgba(255,255,255,0.08);color:inherit;" +
      "border:1px solid rgba(255,255,255,0.15);border-radius:8px;" +
      "font:inherit;font-size:13px;cursor:pointer;}" +
      "#" + LOAD_BTN_ID + ":hover{background:rgba(255,255,255,0.14);}";
    (document.head || document.documentElement).appendChild(style);
  }

  function isStreaming() {
    return !!document.querySelector(STOP_BUTTON_SELECTOR);
  }

  function findTurns() {
    for (const sel of TURN_SELECTOR_STRATEGIES) {
      const list = document.querySelectorAll(sel);
      if (list.length) return Array.from(list).filter((n) => n instanceof HTMLElement);
    }
    return [];
  }

  function ensureVid(node) {
    let vid = node.getAttribute(VID_ATTR);
    if (!vid) {
      vid = String(state.nextVid++);
      node.setAttribute(VID_ATTR, vid);
    }
    return vid;
  }

  function getTurnContainer() {
    const turns = findTurns();
    if (!turns.length) return null;
    return turns[0].parentElement;
  }

  function ensureLoadButton(parent, count) {
    let btn = document.getElementById(LOAD_BTN_ID);
    if (!count) {
      if (btn) btn.remove();
      return;
    }
    const showing = Math.min(LOAD_BATCH_SIZE, count);
    const label = "Load " + showing + " older messages (" + count + " hidden)";
    if (!btn) {
      btn = document.createElement("button");
      btn.id = LOAD_BTN_ID;
      btn.type = "button";
      btn.addEventListener("click", onLoadOlderClick);
    }
    btn.textContent = label;
    if (!parent) return;
    if (btn.parentElement !== parent || parent.firstChild !== btn) {
      parent.insertBefore(btn, parent.firstChild);
    }
  }

  function onLoadOlderClick() {
    if (!detached.length) return;
    const parent = getTurnContainer();
    if (!parent) return;
    const batch = Math.min(LOAD_BATCH_SIZE, detached.length);
    const slice = detached.splice(detached.length - batch, batch);
    state.suppressMutations = true;
    try {
      const btn = document.getElementById(LOAD_BTN_ID);
      const anchor = btn ? btn.nextSibling : parent.firstChild;
      slice.forEach((entry) => parent.insertBefore(entry.node, anchor));
    } finally {
      state.suppressMutations = false;
    }
    applyTrim();
  }

  function applyTrim() {
    if (!state.enabled) return;

    if (isStreaming()) {
      const turns = findTurns();
      state.stats.total = turns.length + detached.length;
      state.stats.rendered = turns.length;
      return;
    }

    const turns = findTurns();
    const parent = turns.length ? turns[0].parentElement : null;
    if (!parent) {
      state.stats.total = detached.length;
      state.stats.rendered = 0;
      return;
    }

    const limit = state.visibleMessages;
    const excess = turns.length - limit;

    state.suppressMutations = true;
    try {
      if (excess > 0) {
        for (let i = 0; i < excess; i++) {
          const node = turns[i];
          ensureVid(node);
          if (node.isConnected) node.parentElement.removeChild(node);
          detached.push({ node });
        }
      }
      ensureLoadButton(parent, detached.length);
    } finally {
      state.suppressMutations = false;
    }

    const visibleAfter = Math.min(turns.length, limit);
    state.stats.total = visibleAfter + detached.length;
    state.stats.rendered = visibleAfter;
  }

  function scheduleApply() {
    if (state.mutationTimer) return;
    state.mutationTimer = setTimeout(() => {
      state.mutationTimer = null;
      applyTrim();
    }, MUTATION_DEBOUNCE_MS);
  }

  function attachObserver() {
    if (state.observer) state.observer.disconnect();
    const root = document.querySelector("main") || document.body;
    if (!root) return;
    state.observer = new MutationObserver(() => {
      if (state.suppressMutations) return;
      scheduleApply();
    });
    state.observer.observe(root, { childList: true, subtree: true });
  }

  function restoreAll() {
    if (!detached.length) {
      const btn = document.getElementById(LOAD_BTN_ID);
      if (btn) btn.remove();
      return;
    }
    const parent = getTurnContainer() || document.querySelector("main") || document.body;
    state.suppressMutations = true;
    try {
      const btn = document.getElementById(LOAD_BTN_ID);
      const anchor = btn ? btn.nextSibling : parent.firstChild;
      detached.forEach((entry) => parent.insertBefore(entry.node, anchor));
      detached.length = 0;
      if (btn) btn.remove();
    } finally {
      state.suppressMutations = false;
    }
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    injectStyle();
    attachObserver();
    applyTrim();
  }

  function teardown() {
    if (state.observer) state.observer.disconnect();
    if (state.mutationTimer) clearTimeout(state.mutationTimer);
    state.observer = null;
    state.mutationTimer = null;
    state.booted = false;
    restoreAll();
  }

  function resetForUrl() {
    if (state.observer) state.observer.disconnect();
    if (state.mutationTimer) clearTimeout(state.mutationTimer);
    state.observer = null;
    state.mutationTimer = null;
    state.booted = false;
    detached.length = 0;
    state.nextVid = 1;
    if (state.enabled) setTimeout(boot, BOOT_DELAY_MS);
  }

  function startUrlWatcher() {
    setInterval(() => {
      if (location.href === state.lastUrl) return;
      state.lastUrl = location.href;
      resetForUrl();
    }, URL_CHECK_INTERVAL);
  }

  function fetchTrimmed() {
    try {
      return document.documentElement.getAttribute(TRIMMED_ATTR) === "1";
    } catch (_) {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;

    if (message.type === "getStats") {
      if (state.enabled) applyTrim();
      sendResponse({
        ok: true,
        data: {
          enabled: state.enabled,
          total: state.stats.total,
          hidden: Math.max(0, state.stats.total - state.stats.rendered),
          rendered: state.stats.rendered,
          visibleMessages: state.visibleMessages,
          mode: state.enabled ? (fetchTrimmed() ? "Active (fast)" : "Active") : "Disabled",
          selectorStrategy: "fetch-intercept+keep-last-n",
        },
      });
      return true;
    }

    if (message.type === "updateConfig") {
      const merged = normalizeConfig({
        enabled: state.enabled,
        visibleMessages: state.visibleMessages,
        ...message.data,
      });
      const wasEnabled = state.enabled;
      const oldVisible = state.visibleMessages;
      state.enabled = merged.enabled;
      state.visibleMessages = merged.visibleMessages;

      chrome.storage.local.set({
        config: { enabled: merged.enabled, visibleMessages: merged.visibleMessages },
      });
      syncToPageScript(merged);

      if (!state.enabled && wasEnabled) {
        teardown();
      } else if (state.enabled && !wasEnabled) {
        boot();
      } else if (state.enabled) {
        applyTrim();
      }

      // If toggled or visible-count changed, reload so the fetch interceptor
      // re-fetches the conversation with the new limit. Otherwise the page
      // still shows whatever it loaded with the previous settings.
      const toggled = wasEnabled !== merged.enabled;
      const limitChanged = oldVisible !== merged.visibleMessages;
      if (message.data && message.data.reload === false) {
        sendResponse({ ok: true });
        return true;
      }
      if (toggled || limitChanged) {
        try {
          localStorage.setItem(BYPASS_KEY, "0");
        } catch (_) {
          /* ignore */
        }
        sendResponse({ ok: true, reloading: true });
        setTimeout(() => location.reload(), 80);
        return true;
      }

      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "loadFullConversation") {
      try {
        localStorage.setItem(BYPASS_KEY, "1");
      } catch (_) {
        /* ignore */
      }
      sendResponse({ ok: true });
      setTimeout(() => location.reload(), 50);
      return true;
    }

    return false;
  });

  // Initial sync: write defaults to localStorage as soon as possible (before
  // page-script runs the first fetch). Then refine when chrome.storage answers.
  syncToPageScript(DEFAULTS);

  chrome.storage.local.get(["config"], (result) => {
    const cfg = normalizeConfig(result.config || DEFAULTS);
    state.enabled = cfg.enabled;
    state.visibleMessages = cfg.visibleMessages;
    syncToPageScript(cfg);
    startUrlWatcher();

    function start() {
      if (state.enabled) setTimeout(boot, BOOT_DELAY_MS);
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  });
})();
