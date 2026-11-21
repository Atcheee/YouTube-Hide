const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");

const script = readFileSync(join(__dirname, "..", "content.js"), "utf8");
const styles = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
const shelf = `<ytd-rich-section-renderer page-subtype="home"><div id="content">
  <ytd-rich-shelf-renderer is-shorts><h2 id="title">Shorts</h2>
    <ytd-rich-item-renderer><ytm-shorts-lockup-view-model-v2>
      <ytm-shorts-lockup-view-model><a href="/shorts/example">Short</a></ytm-shorts-lockup-view-model>
    </ytm-shorts-lockup-view-model-v2></ytd-rich-item-renderer>
  </ytd-rich-shelf-renderer>
</div></ytd-rich-section-renderer>`;

async function setup(t, html) {
  const { window } = new JSDOM(`<style>${styles}</style>${html}`, {
    url: "https://www.youtube.com/", runScripts: "outside-only"
  });
  const { document } = window;
  t.after(() => window.close());
  await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  const frames = [];
  window.requestAnimationFrame = callback => frames.push(callback);
  const change = installSettings(window, { hideStreamedEnabled: false, hideMixEnabled: false, hideMusicEnabled: false });
  window.chrome.runtime.onMessage = { addListener() {} };
  window.eval(script);
  return {
    document, change,
    hidden: element => window.getComputedStyle(element).display === "none",
    async flush() {
      await Promise.resolve();
      while (frames.length) frames.shift()();
    }
  };
}

test("initial and later Shorts shelves stay hidden when YouTube rewrites renderer classes", async t => {
  const page = await setup(t, `${shelf}<ytd-rich-item-renderer id="video"><a href="/watch?v=example">Video</a></ytd-rich-item-renderer>`);
  await page.flush();
  page.document.body.insertAdjacentHTML("beforeend", shelf);
  await page.flush();

  const sections = [...page.document.querySelectorAll("ytd-rich-section-renderer")];
  assert.deepEqual(sections.map(page.hidden), [true, true]);
  for (const section of sections) section.className = "style-scope ytd-rich-grid-renderer";
  assert.deepEqual(sections.map(page.hidden), [true, true]);
  assert.equal(page.hidden(page.document.getElementById("video")), false);

  page.change({ hideShortsEnabled: false, hideStreamedEnabled: true });
  await page.flush();
  assert.deepEqual(sections.map(page.hidden), [false, false]);
});

test("in-place Shorts shelf markers hide and restore an existing section", async t => {
  const page = await setup(t, "<ytd-rich-section-renderer><div id='content'><ytd-rich-shelf-renderer></ytd-rich-shelf-renderer></div></ytd-rich-section-renderer>");
  const section = page.document.querySelector("ytd-rich-section-renderer");
  const renderer = section.querySelector("ytd-rich-shelf-renderer");
  await page.flush();
  assert.equal(page.hidden(section), false);

  renderer.setAttribute("is-shorts", "");
  await page.flush();
  assert.equal(page.hidden(section), true);

  renderer.removeAttribute("is-shorts");
  await page.flush();
  assert.equal(page.hidden(section), false);
});

test("v2 Shorts lockups hide their outer cards before links load", async t => {
  const page = await setup(t, "<ytd-rich-item-renderer><ytm-shorts-lockup-view-model-v2></ytm-shorts-lockup-view-model-v2></ytd-rich-item-renderer>");
  await page.flush();
  assert.equal(page.hidden(page.document.querySelector("ytd-rich-item-renderer")), true);
});
