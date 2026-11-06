/**
 * build-icons.mjs
 * Renders icons/icon.svg to the PNG sizes listed in manifest.json using the
 * Playwright Chromium that is already a dev dependency.
 * Run: node scripts/build-icons.mjs   (from the project root)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const svgPath = path.join(ROOT, 'icons', 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const sizes = Object.keys(manifest.icons || {}).map(Number).sort((a, b) => a - b);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:' + size + 'px;height:' + size + 'px}</style></head><body>' + svg + '</body></html>'
  );
  const out = path.join(ROOT, manifest.icons[String(size)]);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(path.relative(ROOT, out) + '  (' + size + 'x' + size + ')');
}

await browser.close();
