const enableToggle = document.getElementById("enableToggle");
const bufferInput = document.getElementById("bufferSize");
const memorySavedEl = document.getElementById("memorySaved");
const renderedCountEl = document.getElementById("renderedCount");
const statusBar = document.getElementById("statusBar");

// Load saved config
chrome.storage.local.get(["config"], (result) => {
  const cfg = result.config || { enabled: true, bufferSize: 15 };
  enableToggle.checked = cfg.enabled;
  bufferInput.value = cfg.bufferSize;
});

// Request stats from content script
function requestStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "getStats" }).catch(() => {
      statusBar.textContent = "ChatGPT tab not found";
      statusBar.className = "footer";
    });
  });
}

// Listen for stats from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "stats") {
    const d = message.data;
    memorySavedEl.textContent = d.memorySaved + "%";
    renderedCountEl.textContent = d.rendered + " / " + d.total;

    if (d.enabled) {
      statusBar.textContent = "Active — " + d.hidden + " messages hidden";
      statusBar.className = "footer active";
    } else {
      statusBar.textContent = "Speed Booster disabled";
      statusBar.className = "footer disabled";
    }
  }
});

// Send config update to content script
function sendConfig() {
  const cfg = {
    enabled: enableToggle.checked,
    bufferSize: parseInt(bufferInput.value, 10) || 15,
  };

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, {
      type: "updateConfig",
      data: cfg,
    }).catch(() => {});
  });
}

enableToggle.addEventListener("change", sendConfig);

let bufferTimer = null;
bufferInput.addEventListener("input", () => {
  clearTimeout(bufferTimer);
  bufferTimer = setTimeout(sendConfig, 500);
});

// Diagnose button
const diagnoseBtn = document.getElementById("diagnoseBtn");
const debugOutput = document.getElementById("debugOutput");

diagnoseBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "diagnose" }, (response) => {
      if (chrome.runtime.lastError) {
        debugOutput.textContent = "Error: " + chrome.runtime.lastError.message;
      } else if (response && response.data) {
        debugOutput.textContent = JSON.stringify(response.data, null, 2);
      } else {
        debugOutput.textContent = "No response from content script";
      }
      debugOutput.style.display = "block";
    });
  });
});

// Initial stats request
requestStats();
