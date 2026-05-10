const DEFAULT_CONFIG = {
  enabled: true,
  visibleMessages: 15,
};

const enableToggle = document.getElementById("enableToggle");
const visibleInput = document.getElementById("visibleMessages");
const visibleCountEl = document.getElementById("visibleCount");
const hiddenCountEl = document.getElementById("hiddenCount");
const statusBar = document.getElementById("statusBar");

let updateTimer = null;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeConfig(raw) {
  return {
    enabled: raw.enabled !== false,
    visibleMessages: clamp(raw.visibleMessages || DEFAULT_CONFIG.visibleMessages, 2, 200),
  };
}

function readConfig() {
  return {
    enabled: enableToggle.checked,
    visibleMessages: clamp(visibleInput.value, 2, 200),
  };
}

function writeConfig(config) {
  enableToggle.checked = config.enabled;
  visibleInput.value = config.visibleMessages;
}

function withActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    callback(tabs[0]);
  });
}

function sendToContent(message, onResponse) {
  withActiveTab((tab) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        statusBar.textContent = "Open a ChatGPT tab and reload it";
        statusBar.className = "footer disabled";
        if (onResponse) onResponse(null);
        return;
      }

      if (response && response.reloading) {
        statusBar.textContent = "Reloading ChatGPT to apply changes...";
        statusBar.className = "footer active";
      }
      if (response && response.data) updateStats(response.data);
      if (onResponse) onResponse(response);
    });
  });
}

function saveAndSend() {
  const config = readConfig();
  chrome.storage.local.set({ config });
  sendToContent({ type: "updateConfig", data: config });
}

function scheduleSave() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(saveAndSend, 250);
}

function updateStats(data) {
  const total = data.total || 0;
  const hidden = data.hidden || 0;
  const rendered = data.rendered || Math.max(0, total - hidden);

  visibleCountEl.textContent = rendered + " / " + total;
  hiddenCountEl.textContent = String(hidden);

  if (data.enabled) {
    const fast = data.mode && /fast/i.test(data.mode);
    statusBar.textContent = fast
      ? `Active (fast) - older messages trimmed at network`
      : hidden > 0
        ? `Active - ${hidden} older messages detached`
        : "Active - nothing to hide yet";
    statusBar.className = "footer active";
  } else {
    statusBar.textContent = "Speed Booster disabled";
    statusBar.className = "footer disabled";
  }
}

chrome.storage.local.get(["config"], (result) => {
  writeConfig(normalizeConfig(result.config || DEFAULT_CONFIG));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "stats") updateStats(message.data);
});

enableToggle.addEventListener("change", saveAndSend);
visibleInput.addEventListener("input", scheduleSave);

sendToContent({ type: "getStats" });
