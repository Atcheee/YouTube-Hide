(() => {
  "use strict";

  const settings = PlaybackPlusSettings;
  const speedKey = "crunchyrollPlaybackSpeed";
  const toggles = [...document.querySelectorAll("[data-setting]")];
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const slider = document.getElementById("playback-speed");
  const saveStatus = document.getElementById("save-status");
  let state;
  let activeTab;
  let activeSite;
  let speedReady = false;
  let speedRevision = 0;
  let selectedByUser = false;
  let diagnosticRequest = 0;

  function feedback(message, error = false) {
    saveStatus.textContent = message;
    saveStatus.dataset.error = String(error);
  }

  function normalizeRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) ? Math.round(Math.max(.25, Math.min(4, rate)) * 20) / 20 : 1;
  }

  function renderSpeed(value) {
    const rate = normalizeRate(value);
    slider.value = String(rate);
    document.getElementById("speed-value").textContent = `${rate}x`;
    slider.setAttribute("aria-valuetext", `${rate} times normal speed`);
    for (const button of document.querySelectorAll("[data-speed]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.speed) === rate));
    }
  }

  function render() {
    if (!state) return;
    for (const toggle of toggles) {
      toggle.checked = state[toggle.dataset.setting];
      toggle.disabled = toggle.dataset.setting !== "extensionEnabled" && !state.extensionEnabled;
    }
    document.getElementById("youtube-options").disabled = !state.extensionEnabled || !state.youtubeEnabled;
    document.getElementById("crunchyroll-options").disabled = !state.extensionEnabled || !state.crunchyrollEnabled;
    document.getElementById("speed-controls").disabled = !speedReady || !state.crunchyrollSpeedEnabled;
    document.getElementById("general-options").disabled = !state.extensionEnabled;
    document.getElementById("paused-hint").hidden = state.extensionEnabled;
    document.getElementById("reset-settings").disabled = !speedReady;
    renderConnection();
  }

  function selectSite(site, user = false) {
    selectedByUser ||= user;
    for (const tab of tabs) {
      const selected = tab.dataset.site === site;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => selectSite(tab.dataset.site, true));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectSite(tabs[index].dataset.site, true);
      tabs[index].focus();
    });
  }

  function persist(area, values, onFailure) {
    feedback("Saving…");
    chrome.storage[area].set(values, () => {
      if (chrome.runtime.lastError) {
        onFailure?.();
        feedback("Could not save. Try again.", true);
      } else feedback("Saved");
    });
  }

  for (const toggle of toggles) {
    toggle.addEventListener("change", () => {
      const key = toggle.dataset.setting;
      const previous = state[key];
      state = { ...state, [key]: toggle.checked };
      render();
      persist("sync", { [key]: toggle.checked }, () => { state[key] = previous; render(); });
    });
  }

  let savedRate = 1;
  function saveRate(value) {
    speedRevision += 1;
    const rate = normalizeRate(value);
    const previous = savedRate;
    savedRate = rate;
    renderSpeed(rate);
    persist("local", { [speedKey]: rate }, () => { savedRate = previous; renderSpeed(previous); });
  }
  slider.addEventListener("input", () => renderSpeed(slider.value));
  slider.addEventListener("change", () => saveRate(slider.value));
  for (const button of document.querySelectorAll("[data-speed]")) {
    button.addEventListener("click", () => saveRate(button.dataset.speed));
  }
  document.getElementById("reset-settings").addEventListener("click", () => {
    // Reset only our preferences; preserve unrelated storage and one-time skip memory.
    feedback("Resetting…");
    chrome.storage.sync.set({ ...settings.defaults }, () => {
      if (chrome.runtime.lastError) { feedback("Could not reset. Try again.", true); return; }
      saveRate(1);
    });
  });

  function siteForUrl(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return null;
      if (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) return "youtube";
      if (url.hostname === "crunchyroll.com" || url.hostname.endsWith(".crunchyroll.com")) return "crunchyroll";
    } catch { /* An empty/new tab has no supported site. */ }
    return null;
  }

  let connectionState = "checking";
  function renderConnection() {
    const status = document.getElementById("site-status");
    const detail = document.getElementById("site-detail");
    const dot = document.getElementById("connection-dot");
    dot.dataset.state = connectionState;
    if (!activeSite) {
      status.textContent = "YouTube + Crunchyroll";
      detail.textContent = "Open a supported video tab to use player tools.";
    } else {
      const name = activeSite === "youtube" ? "YouTube" : "Crunchyroll";
      const enabled = state?.extensionEnabled && state[`${activeSite}Enabled`];
      status.textContent = `${name} · ${state && !enabled ? "Paused" : connectionState === "connected" ? "Connected" : connectionState === "refresh" ? "Refresh needed" : "Connecting…"}`;
      detail.textContent = state && !enabled ? "Enable tools to resume with your saved preferences." :
        connectionState === "connected" ? "Changes apply to open tabs automatically." : "Your settings are saved for this site.";
      if (state && !enabled) dot.dataset.state = "paused";
    }
  }

  function checkDiagnostics() {
    if (activeSite !== "crunchyroll" || !activeTab?.id) return;
    const request = ++diagnosticRequest;
    const status = document.getElementById("crunchyroll-status");
    status.textContent = "Checking player…";
    chrome.runtime.sendMessage({ type: "crunchyroll-get-status", tabId: activeTab.id }, (response) => {
      const failed = Boolean(chrome.runtime.lastError);
      if (request !== diagnosticRequest) return;
      if (failed || !response?.frames?.length) {
        status.textContent = "Player tools not detected. Refresh this tab.";
        return;
      }
      status.textContent = response.frames.map((frame) => `${frame.frame}: ${frame.state}`).join("\n");
    });
  }
  document.getElementById("check-status").addEventListener("click", checkDiagnostics);
  document.getElementById("refresh-tab").addEventListener("click", () => {
    if (!activeTab?.id || !activeSite) return;
    chrome.tabs.reload(activeTab.id, () => {
      if (chrome.runtime.lastError) feedback("Could not refresh tab.", true);
      else { feedback("Tab refreshed"); window.close(); }
    });
  });

  settings.subscribe((next) => { state = next; render(); });
  const initialSpeedRevision = speedRevision;
  chrome.storage.local.get({ [speedKey]: 1 }, (result) => {
    const failed = Boolean(chrome.runtime.lastError);
    if (speedRevision === initialSpeedRevision) savedRate = normalizeRate(failed ? 1 : result?.[speedKey] ?? 1);
    renderSpeed(savedRate);
    speedReady = true;
    render();
    feedback(failed ? "Could not load speed." : "Settings saved automatically", failed);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, speedKey)) {
      speedRevision += 1;
      savedRate = normalizeRate(changes[speedKey].newValue ?? 1);
      renderSpeed(savedRate);
    }
  });
  document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
  chrome.tabs.query({ active: true, currentWindow: true }, (result) => {
    if (chrome.runtime.lastError) { feedback("Could not check current tab.", true); return; }
    activeTab = result[0];
    activeSite = siteForUrl(activeTab?.url || activeTab?.pendingUrl);
    document.getElementById("refresh-tab").hidden = !activeSite;
    document.getElementById("diagnostics").hidden = activeSite !== "crunchyroll";
    if (!activeSite || !activeTab?.id) { renderConnection(); return; }
    if (!selectedByUser) selectSite(activeSite);
    chrome.tabs.sendMessage(activeTab.id, { type: "playback-plus-ping" }, { frameId: 0 }, (response) => {
      const failed = Boolean(chrome.runtime.lastError);
      connectionState = !failed && response?.version === chrome.runtime.getManifest().version ? "connected" : "refresh";
      document.getElementById("refresh-hint").hidden = connectionState === "connected";
      renderConnection();
    });
    checkDiagnostics();
  });
})();
