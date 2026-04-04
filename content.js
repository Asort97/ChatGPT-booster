/**
 * ChatGPT Speed Booster — Content Script v2
 * 
 * Simple approach: just toggle display:none on off-screen conversation turns.
 * No innerHTML copying, no heavy processing. Pure CSS visibility toggling.
 */

(function () {
  "use strict";

  const LOG = (...args) => console.log("[SpeedBooster]", ...args);

  const DEFAULTS = { enabled: true, bufferSize: 10 };
  let config = { ...DEFAULTS };
  let isActive = false;
  let tickInterval = null;
  let lastAnchor = -1; // last known viewport anchor index

  // --- CSS injection: fastest way to bulk-hide ---
  const style = document.createElement("style");
  style.id = "speed-booster-style";
  document.head.appendChild(style);

  function hideByCSS(selector, hideIndices) {
    // Build CSS rules to hide specific conversation turns by nth-child
    // This is the fastest method — browser handles it natively
    if (hideIndices.length === 0) {
      style.textContent = "";
      return;
    }

    const rules = hideIndices
      .map(i => `${selector}:nth-child(${i + 1})`)
      .join(",\n");

    style.textContent = `${rules} { display: none !important; }`;
  }

  function clearCSS() {
    style.textContent = "";
  }

  // --- Find conversation turns ---

  const SELECTOR = '[data-testid^="conversation-turn-"]';

  function getTurns() {
    return document.querySelectorAll(SELECTOR);
  }

  // --- Find scroll container ---

  function getScrollContainer() {
    // ChatGPT's scroll container: walk up from first turn
    const turn = document.querySelector(SELECTOR);
    if (!turn) return null;

    let el = turn.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 100) {
        return el;
      }
      el = el.parentElement;
    }

    // Fallback: walk up from main
    const main = document.querySelector("main");
    if (main) {
      const all = main.querySelectorAll("*");
      for (const candidate of all) {
        const s = getComputedStyle(candidate);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
            candidate.scrollHeight > candidate.clientHeight + 100) {
          return candidate;
        }
      }
    }

    return null;
  }

  // --- Core logic: figure out which turns to show/hide ---

  function updateDirect() {
    if (!config.enabled) return;

    const turns = getTurns();
    const count = turns.length;
    if (count === 0) return;

    const buf = config.bufferSize;
    const vh = window.innerHeight;

    // Find anchor: a visible turn near viewport
    // Start search near last known anchor for speed (O(buf) instead of O(n))
    let anchorIdx = -1;
    const searchStart = (lastAnchor >= 0 && lastAnchor < count) ? Math.max(0, lastAnchor - buf) : 0;
    const searchEnd = Math.min(count, searchStart + buf * 4);

    for (let i = searchStart; i < searchEnd; i++) {
      const turn = turns[i];
      if (turn.dataset.sbHidden) continue;
      const rect = turn.getBoundingClientRect();
      if (rect.bottom > -300 && rect.top < vh + 300) {
        anchorIdx = i;
      }
      // Once we've gone past the viewport, stop
      if (rect.top > vh + 500) break;
    }

    // Fallback: full scan if focused search failed
    if (anchorIdx === -1) {
      for (let i = 0; i < count; i++) {
        if (turns[i].dataset.sbHidden) continue;
        const rect = turns[i].getBoundingClientRect();
        if (rect.bottom > -300 && rect.top < vh + 300) {
          anchorIdx = i;
        }
        if (rect.top > vh + 500) break;
      }
    }

    if (anchorIdx === -1) anchorIdx = count - 1;
    lastAnchor = anchorIdx;

    const keepStart = Math.max(0, anchorIdx - buf);
    const keepEnd = Math.min(count - 1, anchorIdx + buf);

    let hiddenCount = 0;

    for (let i = 0; i < count; i++) {
      const turn = turns[i];
      const shouldHide = (i < keepStart || i > keepEnd) && i !== count - 1;

      if (shouldHide) {
        if (!turn.dataset.sbHidden) {
          turn.dataset.sbHidden = "1";
          turn.style.setProperty("display", "none", "important");
        }
        hiddenCount++;
      } else {
        if (turn.dataset.sbHidden) {
          turn.removeAttribute("style");
          delete turn.dataset.sbHidden;
        }
      }
    }

    LOG("Updated: anchor=", anchorIdx, "keep=", keepStart, "-", keepEnd, "hidden=", hiddenCount, "/", count);
    sendStats(count, hiddenCount);
  }

  // --- Scroll handling ---

  let scrollContainer = null;
  let scrollTimer = null;

  function onScroll() {
    if (scrollTimer) return; // throttle
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      updateDirect();
    }, 100);
  }

  function attachScroll() {
    scrollContainer = getScrollContainer();
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", onScroll, { passive: true });
      LOG("Attached scroll listener to:", scrollContainer.className.slice(0, 50));
    } else {
      window.addEventListener("scroll", onScroll, { passive: true });
      LOG("Attached scroll listener to window");
    }
  }

  function detachScroll() {
    if (scrollContainer) {
      scrollContainer.removeEventListener("scroll", onScroll);
    }
    window.removeEventListener("scroll", onScroll);
    scrollContainer = null;
  }

  // --- Stats ---

  function sendStats(total, hidden) {
    try {
      chrome.runtime.sendMessage({
        type: "stats",
        data: {
          total,
          rendered: total - hidden,
          hidden,
          memorySaved: total > 0 ? Math.round((hidden / total) * 100) : 0,
          enabled: config.enabled,
        },
      });
    } catch (e) { /* popup closed */ }
  }

  // --- Periodic tick: handles new messages, DOM changes ---

  function startTick() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      if (!config.enabled) return;
      const turns = getTurns();
      if (turns.length > 0 && !isActive) {
        LOG("Found", turns.length, "turns, activating");
        isActive = true;
        attachScroll();
        updateDirect();
      } else if (isActive) {
        // Just update to catch new messages
        updateDirect();
      }
    }, 3000);
  }

  // --- Init / Reset ---

  function reset() {
    // Unhide everything
    const turns = getTurns();
    for (const turn of turns) {
      if (turn.dataset.sbHidden) {
        turn.removeAttribute("style");
        delete turn.dataset.sbHidden;
      }
    }
    clearCSS();
    detachScroll();
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    isActive = false;
  }

  function init() {
    LOG("Init, URL:", location.href);

    const turns = getTurns();
    if (turns.length > 0) {
      LOG("Found", turns.length, "conversation turns");
      isActive = true;
      attachScroll();
      updateDirect();
    } else {
      LOG("No turns yet, waiting...");
    }

    startTick();
  }

  // --- URL watcher (SPA navigation) ---

  function watchURL() {
    let lastURL = location.href;
    const check = () => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        LOG("URL changed");
        reset();
        setTimeout(init, 1500);
      }
    };
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () { origPush.apply(this, arguments); check(); };
    history.replaceState = function () { origReplace.apply(this, arguments); check(); };
    window.addEventListener("popstate", check);
  }

  // --- Diagnosis ---

  function diagnoseDOM() {
    const main = document.querySelector("main");
    const turns = getTurns();
    const sc = getScrollContainer();
    return {
      url: location.href,
      hasMain: !!main,
      totalDOM: document.querySelectorAll("*").length,
      turns: turns.length,
      hiddenTurns: Array.from(turns).filter(t => t.dataset.sbHidden).length,
      scrollContainer: sc ? { tag: sc.tagName, class: sc.className.slice(0, 80), scrollH: sc.scrollHeight } : null,
      isActive,
    };
  }

  // --- Message handler ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "getStats") {
      const turns = getTurns();
      const hidden = Array.from(turns).filter(t => t.dataset.sbHidden).length;
      sendStats(turns.length, hidden);
      sendResponse({ ok: true });
    } else if (msg.type === "updateConfig") {
      const wasEnabled = config.enabled;
      config = { ...config, ...msg.data };
      if (config.enabled && !wasEnabled) init();
      else if (!config.enabled && wasEnabled) { reset(); sendStats(0, 0); }
      else if (config.enabled) updateDirect();
      chrome.storage.local.set({ config });
      sendResponse({ ok: true });
    } else if (msg.type === "diagnose") {
      sendResponse({ ok: true, data: diagnoseDOM() });
    }
    return true;
  });

  // --- Start ---

  chrome.storage.local.get(["config"], (result) => {
    if (result.config) config = { ...DEFAULTS, ...result.config };
    LOG("Config:", JSON.stringify(config));
    if (config.enabled) setTimeout(init, 1000);
    watchURL();
  });
})();
