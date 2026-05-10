// Tests for ChatGPT Speed Booster.
// 1) Fetch interceptor (page-script.js) - tree trimming logic in jsdom MAIN world.
// 2) Content script (content.js) - keep-last-N DOM fallback in jsdom ISOLATED world.

const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, "page-script.js"), "utf8");
const CONTENT_SCRIPT = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log("  PASS:", label);
  } else {
    fail++;
    failures.push(label);
    console.log("  FAIL:", label);
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------
// Build a realistic ChatGPT conversation tree.
// Structure: system root -> turn1_user -> turn1_assistant -> turn2_user -> ...
// -----------------------------------------------------------------------
function buildConversation(turnCount) {
  const mapping = {};
  let parent = null;

  // System root
  const sysId = "node-system";
  mapping[sysId] = {
    id: sysId,
    parent: null,
    children: [],
    message: { author: { role: "system" }, content: { parts: ["sys"] } },
  };
  parent = sysId;

  let lastVisible = null;
  for (let t = 0; t < turnCount; t++) {
    const userId = "node-user-" + t;
    const asstId = "node-asst-" + t;
    mapping[userId] = {
      id: userId,
      parent: parent,
      children: [asstId],
      message: { author: { role: "user" }, content: { parts: ["q" + t] } },
    };
    mapping[parent].children.push(userId);
    mapping[asstId] = {
      id: asstId,
      parent: userId,
      children: [],
      message: { author: { role: "assistant" }, content: { parts: ["a" + t] } },
    };
    parent = asstId;
    lastVisible = asstId;
  }

  return {
    mapping,
    current_node: lastVisible,
    title: "Test chat",
    create_time: 1700000000,
  };
}

function makeMainWorld() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body></body></html>`,
    { url: "https://chatgpt.com/c/test", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;

  // jsdom doesn't expose fetch/Response/Headers; bring in node's built-ins.
  window.Response = globalThis.Response;
  window.Headers = globalThis.Headers;
  window.Request = globalThis.Request;
  window.URL = globalThis.URL;

  let interceptedUrl = null;
  window.fetch = async function stubFetch(input, init) {
    interceptedUrl = typeof input === "string" ? input : input.url;
    const data = window.__nextResponseData;
    const body = JSON.stringify(data);
    const res = new window.Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(res, "url", { value: interceptedUrl });
    return res;
  };
  window.__getInterceptedUrl = () => interceptedUrl;

  // Run page-script in this realm.
  const fn = new window.Function(PAGE_SCRIPT);
  fn.call(window);

  return { dom, window };
}

async function readJson(res) {
  const text = await res.text();
  return JSON.parse(text);
}

// -----------------------------------------------------------------------
async function testTreeTrim_basic() {
  console.log("\n[test] fetch trim: long chat (50 turns)");
  const { window } = makeMainWorld();
  window.__SB_PUSH_SETTINGS__({ enabled: true, visibleMessages: 5 });
  window.__nextResponseData = buildConversation(50);

  const res = await window.fetch("https://chatgpt.com/backend-api/conversation/abc123");
  const data = await readJson(res);

  const nodes = Object.values(data.mapping);
  const visibleCount = nodes.filter(
    (n) => n.message && ["user", "assistant", "tool"].includes(n.message.author.role),
  ).length;
  // limit = 5 turns * 2 api/turn * 4 buffer = 40
  assert(visibleCount === 40, `kept 40 visible api messages (got ${visibleCount})`);
  assert(data.current_node === "node-asst-49", "current_node preserved");
  // Trimmed attribute set
  assert(
    window.document.documentElement.getAttribute("data-sb-trimmed") === "1",
    "data-sb-trimmed flag set",
  );
}

async function testTreeTrim_shortChatUntouched() {
  console.log("\n[test] fetch trim: short chat (3 turns) untouched");
  const { window } = makeMainWorld();
  window.__SB_PUSH_SETTINGS__({ enabled: true, visibleMessages: 15 });
  window.__nextResponseData = buildConversation(3);

  const res = await window.fetch("https://chatgpt.com/backend-api/conversation/abc");
  const data = await readJson(res);
  const nodes = Object.values(data.mapping);
  // 3 turns = 7 nodes (1 system + 6 visible)
  assert(nodes.length === 7, `untrimmed: 7 nodes (got ${nodes.length})`);
  assert(
    window.document.documentElement.getAttribute("data-sb-trimmed") !== "1",
    "trimmed flag NOT set for short chat",
  );
}

async function testTreeTrim_disabled() {
  console.log("\n[test] fetch trim: disabled passes through");
  const { window } = makeMainWorld();
  window.__SB_PUSH_SETTINGS__({ enabled: false, visibleMessages: 5 });
  window.__nextResponseData = buildConversation(50);

  const res = await window.fetch("https://chatgpt.com/backend-api/conversation/x");
  const data = await readJson(res);
  const nodes = Object.values(data.mapping);
  // 50 turns = 1 + 100 = 101 nodes
  assert(nodes.length === 101, `disabled: all 101 nodes pass through (got ${nodes.length})`);
}

async function testTreeTrim_skipNonConversationUrls() {
  console.log("\n[test] fetch trim: non-conversation URLs ignored");
  const { window } = makeMainWorld();
  window.__SB_PUSH_SETTINGS__({ enabled: true, visibleMessages: 5 });
  window.__nextResponseData = { foo: "bar" };

  const res1 = await window.fetch("https://chatgpt.com/backend-api/conversations?limit=20");
  const data1 = await readJson(res1);
  assert(data1.foo === "bar", "/conversations (list) is excluded");

  const res2 = await window.fetch("https://chatgpt.com/api/me");
  const data2 = await readJson(res2);
  assert(data2.foo === "bar", "/api/me is not intercepted");
}

async function testTreeTrim_chainIntegrity() {
  console.log("\n[test] fetch trim: kept chain has valid parent/children pointers");
  const { window } = makeMainWorld();
  window.__SB_PUSH_SETTINGS__({ enabled: true, visibleMessages: 3 });
  window.__nextResponseData = buildConversation(30);

  const res = await window.fetch("https://chatgpt.com/backend-api/conversation/y");
  const data = await readJson(res);

  // Walk from current_node up via parent pointers; should reach a node with parent=null without breaking.
  const visited = new Set();
  let nid = data.current_node;
  let depth = 0;
  while (nid && data.mapping[nid] && !visited.has(nid)) {
    visited.add(nid);
    depth++;
    nid = data.mapping[nid].parent;
  }
  assert(nid === null, "chain terminates at parent=null");
  assert(depth === Object.keys(data.mapping).length, "all kept nodes are on the chain");

  // Verify forward children pointers reach current_node.
  // Find root.
  const ids = Object.keys(data.mapping);
  const root = ids.find((id) => data.mapping[id].parent === null);
  assert(!!root, "exactly one root node exists");
  let cur = root;
  let forward = 0;
  while (cur) {
    forward++;
    const ch = data.mapping[cur].children;
    cur = ch && ch.length ? ch[0] : null;
  }
  assert(forward === depth, "forward walk length matches backward walk");
}

async function testTreeTrim_oneShotBypass() {
  console.log("\n[test] fetch trim: one-shot bypass");
  const { window } = makeMainWorld();
  window.__SB_PUSH_SETTINGS__({ enabled: true, visibleMessages: 5 });
  window.localStorage.setItem("sb_skip_trim_once", "1");
  window.__nextResponseData = buildConversation(50);

  const res = await window.fetch("https://chatgpt.com/backend-api/conversation/z");
  const data = await readJson(res);
  const nodes = Object.values(data.mapping);
  assert(nodes.length === 101, `bypass: full chat returned (got ${nodes.length})`);
  assert(
    window.localStorage.getItem("sb_skip_trim_once") === null,
    "bypass flag consumed",
  );
}

// -----------------------------------------------------------------------
// DOM fallback tests (content.js)
// -----------------------------------------------------------------------
function makeContentDom({ schema, count, visibleMessages = 15 }) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main id="main"></main></body></html>`,
    { url: "https://chatgpt.com/c/test", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;
  const main = window.document.getElementById("main");

  for (let i = 0; i < count; i++) {
    const tag = schema === "article-testid" ? "article" : "div";
    const node = window.document.createElement(tag);
    if (schema === "article-testid" || schema === "div-testid") {
      node.setAttribute("data-testid", `conversation-turn-${i}`);
    } else if (schema === "div-author-role") {
      node.setAttribute("data-message-author-role", i % 2 ? "user" : "assistant");
    }
    node.textContent = "M" + i;
    main.appendChild(node);
  }

  let storedConfig = { enabled: true, visibleMessages };
  const messageListeners = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: () => {},
      lastError: null,
    },
    storage: {
      local: {
        get: (_keys, cb) => cb({ config: storedConfig }),
        set: (data) => {
          if (data.config) storedConfig = data.config;
        },
      },
    },
  };
  window.__sendMessage = (msg) =>
    new Promise((resolve) => {
      const listener = messageListeners[0];
      if (!listener) return resolve(null);
      listener(msg, {}, resolve);
    });

  const fn = new window.Function(CONTENT_SCRIPT);
  fn.call(window);
  return dom;
}

async function testDomFallback() {
  console.log("\n[test] DOM fallback: keeps last 15 of 30");
  const dom = makeContentDom({ schema: "div-testid", count: 30 });
  await wait(1000);
  const stats = await dom.window.__sendMessage({ type: "getStats" });
  assert(stats.data.total === 30, `total=30 (got ${stats.data.total})`);
  assert(stats.data.rendered === 15, `rendered=15 (got ${stats.data.rendered})`);
  const inDom = dom.window.document.querySelectorAll(
    '[data-testid^="conversation-turn-"]',
  ).length;
  assert(inDom === 15, `15 in DOM (got ${inDom})`);
  dom.window.close();
}

async function testSettingsSyncedToLocalStorage() {
  console.log("\n[test] content script syncs settings to localStorage");
  const dom = makeContentDom({ schema: "div-testid", count: 5, visibleMessages: 7 });
  await wait(50);
  const ls = dom.window.localStorage.getItem("sb_fetch_settings");
  assert(!!ls, "localStorage key sb_fetch_settings written");
  if (ls) {
    const parsed = JSON.parse(ls);
    assert(parsed.enabled === true, "synced enabled=true");
    assert(parsed.visibleMessages === 7, `synced visibleMessages=7 (got ${parsed.visibleMessages})`);
  }
  dom.window.close();
}

(async () => {
  try {
    await testTreeTrim_basic();
    await testTreeTrim_shortChatUntouched();
    await testTreeTrim_disabled();
    await testTreeTrim_skipNonConversationUrls();
    await testTreeTrim_chainIntegrity();
    await testTreeTrim_oneShotBypass();
    await testDomFallback();
    await testSettingsSyncedToLocalStorage();
  } catch (err) {
    console.error("CRASH:", err.stack || err);
    fail++;
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) {
    failures.forEach((f) => console.log("  -", f));
    process.exit(1);
  }
})();
