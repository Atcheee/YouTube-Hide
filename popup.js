(() => {
  "use strict";

  const settings = PlaybackPlusSettings;
  const toggles = [...document.querySelectorAll("[data-setting]")];
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const speedControls = [...document.querySelectorAll("[data-speed-site]")].map(group => ({
    group,
    site: group.dataset.speedSite,
    key: group.dataset.speedSite + "PlaybackSpeed",
    slider: group.querySelector("input"),
    output: group.querySelector("output"),
    presets: group.querySelectorAll("[data-speed]"),
    savedRate: 1,
    revision: 0
  }));
  const saveStatus = document.getElementById("save-status");
  let state;
  let activeTab;
  let activeSite;
  let speedReady = false;
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

  function renderSpeed(control, value) {
    const rate = normalizeRate(value);
    control.slider.value = String(rate);
    control.output.textContent = `${rate}x`;
    control.slider.setAttribute("aria-valuetext", `${rate} times normal speed`);
    for (const button of control.presets) {
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
    document.getElementById("hbomax-options").disabled = !state.extensionEnabled || !state.hbomaxEnabled;
    document.getElementById("disneyplus-options").disabled = !state.extensionEnabled || !state.disneyplusEnabled;
    for (const control of speedControls) control.group.disabled = !speedReady || !state[control.site + "SpeedEnabled"];
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

  function saveRate(control, value) {
    const revision = ++control.revision;
    const rate = normalizeRate(value);
    const previous = control.savedRate;
    control.savedRate = rate;
    renderSpeed(control, rate);
    persist("local", { [control.key]: rate }, () => {
      if (control.revision !== revision) return;
      control.savedRate = previous;
      renderSpeed(control, previous);
    });
  }
  for (const control of speedControls) {
    control.slider.addEventListener("input", () => renderSpeed(control, control.slider.value));
    control.slider.addEventListener("change", () => saveRate(control, control.slider.value));
    for (const button of control.presets) button.addEventListener("click", () => saveRate(control, button.dataset.speed));
  }
  document.getElementById("reset-settings").addEventListener("click", () => {
    // Reset only our preferences; preserve unrelated storage and one-time skip memory.
    feedback("Resetting…");
    chrome.storage.sync.set({ ...settings.defaults }, () => {
      if (chrome.runtime.lastError) { feedback("Could not reset. Try again.", true); return; }
      persist("local", { crunchyrollPlaybackSpeed: 1, hbomaxPlaybackSpeed: 1, disneyplusPlaybackSpeed: 1 });
    });
  });

  function siteForUrl(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return null;
      if (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) return "youtube";
      if (url.hostname === "crunchyroll.com" || url.hostname.endsWith(".crunchyroll.com")) return "crunchyroll";
      if (url.hostname === "hbomax.com" || url.hostname.endsWith(".hbomax.com")) return "hbomax";
      if (url.hostname === "disneyplus.com" || url.hostname.endsWith(".disneyplus.com")) return "disneyplus";
    } catch { /* An empty/new tab has no supported site. */ }
    return null;
  }

  let connectionState = "checking";
  function ping(callback) {
    chrome.tabs.sendMessage(activeTab.id, { type: "playback-plus-ping" }, { frameId: 0 }, response => {
      const failed = Boolean(chrome.runtime.lastError);
      callback(!failed && response?.version === chrome.runtime.getManifest().version);
    });
  }

  function finishConnection(connected) {
    connectionState = connected ? "connected" : "refresh";
    document.getElementById("refresh-hint").hidden = connected;
    renderConnection();
    if (connected) checkDiagnostics();
  }

  function connect() {
    ping(connected => {
      if (connected) { finishConnection(true); return; }
      connectionState = "checking";
      renderConnection();
      const registration = chrome.runtime.getManifest().content_scripts.find(entry =>
        entry.world !== "MAIN" && entry.matches.some(pattern => pattern.includes(`${activeSite}.com`)));
      if (!registration || !chrome.scripting) { finishConnection(false); return; }
      const target = { tabId: activeTab.id, allFrames: registration.all_frames === true };
      // Restore a missing content-script connection without navigating the tab.
      // Each module guards its installation, preserving state on repeated retries.
      const install = () => chrome.scripting.insertCSS({ target, files: registration.css }, () => {
        if (chrome.runtime.lastError) { finishConnection(false); return; }
        chrome.scripting.executeScript({ target, files: registration.js }, () => {
          if (chrome.runtime.lastError) { finishConnection(false); return; }
          ping(finishConnection);
        });
      });
      const bridge = chrome.runtime.getManifest().content_scripts.find(entry =>
        entry.world === "MAIN" && entry.matches.some(pattern => pattern.includes(`${activeSite}.com`)));
      if (bridge) {
        chrome.scripting.executeScript({ target, files: bridge.js, world: "MAIN" }, () => {
          if (chrome.runtime.lastError) { finishConnection(false); return; }
          install();
        });
      } else install();
    });
  }

  function renderConnection() {
    const status = document.getElementById("site-status");
    const detail = document.getElementById("site-detail");
    const dot = document.getElementById("connection-dot");
    dot.dataset.state = connectionState;
    if (!activeSite) {
      status.textContent = "YouTube, Crunchyroll, HBO Max & Disney+";
      detail.textContent = "Open a supported video tab to use player tools.";
    } else {
      const name = { youtube: "YouTube", crunchyroll: "Crunchyroll", hbomax: "HBO Max", disneyplus: "Disney+" }[activeSite];
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
  const initialRevisions = speedControls.map(control => control.revision);
  chrome.storage.local.get(Object.fromEntries(speedControls.map(control => [control.key, 1])), (result) => {
    const failed = Boolean(chrome.runtime.lastError);
    for (const [index, control] of speedControls.entries()) {
      if (control.revision === initialRevisions[index]) control.savedRate = normalizeRate(failed ? 1 : result?.[control.key] ?? 1);
      renderSpeed(control, control.savedRate);
    }
    speedReady = true;
    render();
    feedback(failed ? "Could not load speed." : "Settings saved automatically", failed);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const control of speedControls) {
      if (!Object.hasOwn(changes, control.key)) continue;
      control.revision += 1;
      control.savedRate = normalizeRate(changes[control.key].newValue ?? 1);
      renderSpeed(control, control.savedRate);
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
    connect();
  });
})();
