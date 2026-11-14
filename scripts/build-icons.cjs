const { chromium } = require("playwright-core");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

(async () => {
  const executablePath = [process.env.PLAYBACK_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set PLAYBACK_TEST_BROWSER to a Chromium browser executable.");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const source = readFileSync(join(__dirname, "..", "icons", "icon.svg"), "utf8");
    const icons = await page.evaluate(async (svg) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      return [16, 32, 48, 128].map((size) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);
        return { size, data: canvas.toDataURL("image/png").split(",")[1] };
      });
    }, source);
    for (const { size, data } of icons) {
      writeFileSync(join(__dirname, "..", "icons", `icon-${size}.png`), Buffer.from(data, "base64"));
    }
    console.log("Built Playback Plus icons: 16, 32, 48, 128px.");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
