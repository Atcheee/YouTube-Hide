"use strict";

const crunchyrollReports = new Map();

// The top watch page owns the per-episode memory, including across player-frame
// reloads. Relay only our Crunchyroll frame messages back to that same tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "crunchyroll-get-status" && Number.isInteger(message.tabId)) {
    crunchyrollReports.set(message.tabId, new Map());
    chrome.tabs.sendMessage(message.tabId, { type: "crunchyroll-report-status" }, () => { void chrome.runtime.lastError; });
    setTimeout(() => {
      sendResponse({ frames: [...(crunchyrollReports.get(message.tabId)?.values() || [])] });
      crunchyrollReports.delete(message.tabId);
    }, 150);
    return true;
  }
  if (message?.type !== "crunchyroll-skip-intro" && message?.type !== "crunchyroll-status") return false;
  let hostname;
  try { hostname = new URL(sender.url).hostname; } catch { return false; }
  if (!/^(?:[\w-]+\.)*crunchyroll\.com$/.test(hostname) ||
      !Number.isInteger(sender.tab?.id)) return false;

  if (message.type === "crunchyroll-status") {
    const reports = crunchyrollReports.get(sender.tab.id);
    if (reports && message.status) reports.set(sender.frameId, message.status);
    sendResponse({ ok: true });
    return false;
  }
  if (sender.frameId === 0) return false;

  chrome.tabs.sendMessage(sender.tab.id, {
    type: "crunchyroll-claim-intro",
    manual: message.manual === true,
    action: message.action,
    episodeId: message.episodeId,
    token: message.token
  }, { frameId: 0 }, (response) => {
    if (chrome.runtime.lastError) { sendResponse({ allowed: false, reason: chrome.runtime.lastError.message }); return; }
    sendResponse(response || { allowed: false });
  });
  return true;
});
