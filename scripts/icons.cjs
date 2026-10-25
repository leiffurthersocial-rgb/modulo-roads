// Renders public/icons/icon.svg to the PNG sizes iOS and the web manifest need.
// Usage: node scripts/icons.cjs   (requires Playwright + Chromium)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const dir = path.join(__dirname, '..', 'public', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [size, name, pad] of [[180, 'icon-180.png', 0.0001], [192, 'icon-192.png', 0], [512, 'icon-512.png', 0], [512, 'icon-512-maskable.png', 0.1]]) {
    await page.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * (1 - pad * 2));
    await page.setContent(`<html><body style="margin:0;background:${pad ? '#f3b07a' : 'transparent'};display:grid;place-items:center;width:${size}px;height:${size}px;overflow:hidden">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body></html>`);
    await page.screenshot({ path: path.join(dir, name), omitBackground: !pad });
  }
  await browser.close();
  console.log('icons written');
})();
