/**
 * screenshot.js
 * NetSuite TactaSuite - Screenshot Studio (Background Module)
 *
 * @author Blane Maher
 *
 * Handles the capture side of Screenshot Studio. The content script owns the
 * page (masking, scrolling, hiding fixed chrome); this module owns everything
 * that needs the chrome.tabs API and an OffscreenCanvas:
 *
 *   shotCaptureVisible { tabId }            -> one captureVisibleTab
 *   shotCaptureFull    { tabId }            -> scroll + stitch tiles
 *   shotCaptureArea    { tabId, rect, viewport } -> capture + crop
 *
 * Each handler resolves to { dataUrl, width, height, mode, truncated? }.
 * handleScreenshotMessage returns undefined for actions it does not own so
 * the service worker switch can fall through to its own cases.
 *
 * Content-script protocol used by the full-page stitch (all via
 * chrome.tabs.sendMessage to frame 0):
 *   shotPrepare    -> metrics (also remembers scroll position)
 *   shotTagFixed   -> neutralise fixed/sticky elements, returns fresh metrics
 *   shotScrollTo   -> { y } scroll, returns { scrollX, scrollY }
 *   shotUntagFixed -> undo shotTagFixed
 *   shotRestore    -> restore scroll position
 *
 * The only in-memory state is a throttle timestamp for the captureVisibleTab
 * quota (roughly 2 calls per second). Losing it on worker restart just means
 * one extra wait, so it is not persisted.
 */

const MAX_FULL_HEIGHT_PX = 8000;
const MAX_TILES = 24;
const MIN_CAPTURE_INTERVAL_MS = 550;
const SETTLE_MS = 350;
const SHOT_ACTIONS = ['shotCaptureVisible', 'shotCaptureFull', 'shotCaptureArea'];

let lastCaptureAt = 0;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Route a Screenshot Studio message.
 *
 * @param {Object} message - Message payload with an `action` key.
 * @param {Object} sender  - chrome.runtime sender (tab is used when tabId is absent).
 * @returns {Promise<Object|undefined>} Result for shot* actions, undefined otherwise.
 */
export async function handleScreenshotMessage(message, sender) {
  if (!message || typeof message.action !== 'string') return undefined;
  if (SHOT_ACTIONS.indexOf(message.action) === -1) return undefined;

  const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
  if (!tabId) throw new Error('No tab ID available for screenshot.');

  switch (message.action) {
    case 'shotCaptureVisible':
      return captureVisible(tabId);
    case 'shotCaptureFull':
      return captureFull(tabId);
    case 'shotCaptureArea':
      return captureArea(tabId, message.rect, message.viewport);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Capture modes
// ---------------------------------------------------------------------------

async function captureVisible(tabId) {
  const windowId = await getWindowId(tabId);
  const dataUrl = await throttledCapture(windowId);
  const bitmap = await decode(dataUrl);
  const result = { dataUrl, width: bitmap.width, height: bitmap.height, mode: 'visible', truncated: false };
  bitmap.close();
  return result;
}

async function captureFull(tabId) {
  const windowId = await getWindowId(tabId);
  const prep = await sendToTab(tabId, { action: 'shotPrepare' });
  if (!prep || !prep.viewportHeight) {
    throw new Error('Page did not report its dimensions. Reload the page and try again.');
  }

  let tagged = false;
  try {
    // Fixed/sticky elements become static so they appear once instead of in
    // every tile. That changes layout, so the metrics are re-read afterwards.
    let metrics = prep;
    try {
      const refreshed = await sendToTab(tabId, { action: 'shotTagFixed' });
      tagged = true;
      if (refreshed && refreshed.viewportHeight) metrics = Object.assign({}, prep, refreshed);
    } catch (_) {
      // Tagging is best effort; stitching still works without it.
    }

    const scrollHeight = Math.max(1, Math.floor(metrics.scrollHeight || metrics.viewportHeight));
    const step = Math.max(1, Math.floor(metrics.viewportHeight));
    const totalCss = Math.min(scrollHeight, MAX_FULL_HEIGHT_PX);
    let truncated = scrollHeight > MAX_FULL_HEIGHT_PX;

    const tiles = [];
    for (let y = 0; y < totalCss; y += step) {
      if (tiles.length >= MAX_TILES) {
        truncated = true;
        break;
      }
      let scrolled = null;
      try {
        scrolled = await sendToTab(tabId, { action: 'shotScrollTo', y });
      } catch (e) {
        throw new Error('Lost contact with the page while scrolling: ' + e.message);
      }
      await sleep(SETTLE_MS);
      const dataUrl = await throttledCapture(windowId);
      const actualY = (scrolled && typeof scrolled.scrollY === 'number') ? scrolled.scrollY : y;
      tiles.push({ dataUrl, y: Math.max(0, actualY) });
    }

    if (tiles.length === 0) throw new Error('No tiles were captured.');

    const composed = await composeTiles(tiles, metrics, totalCss);
    return Object.assign(composed, { mode: 'full', truncated, tiles: tiles.length, pageHeight: scrollHeight });
  } finally {
    if (tagged) {
      try { await sendToTab(tabId, { action: 'shotUntagFixed' }); } catch (_) { /* ignore */ }
    }
    try { await sendToTab(tabId, { action: 'shotRestore' }); } catch (_) { /* ignore */ }
  }
}

async function captureArea(tabId, rect, viewport) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    throw new Error('No capture area was supplied.');
  }
  const windowId = await getWindowId(tabId);
  const dataUrl = await throttledCapture(windowId);
  const bitmap = await decode(dataUrl);

  try {
    const vp = viewport || {};
    const dpr = vp.dpr > 0 ? vp.dpr : 1;
    const scaleX = vp.innerWidth > 0 ? bitmap.width / vp.innerWidth : dpr;
    const scaleY = vp.innerHeight > 0 ? bitmap.height / vp.innerHeight : dpr;

    const sx = clamp(Math.round(rect.left * scaleX), 0, bitmap.width - 1);
    const sy = clamp(Math.round(rect.top * scaleY), 0, bitmap.height - 1);
    const sw = clamp(Math.round(rect.width * scaleX), 1, bitmap.width - sx);
    const sh = clamp(Math.round(rect.height * scaleY), 1, bitmap.height - sy);

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = await canvasToDataUrl(canvas);
    return { dataUrl: out, width: sw, height: sh, mode: 'area', truncated: false };
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/**
 * Compose captured tiles into one tall image.
 *
 * Tiles are placed by the scroll position the page actually reached. The last
 * tile normally overlaps the previous one (the page cannot scroll past its
 * end), so only the uncovered remainder of each tile is drawn.
 *
 * @param {Array<{dataUrl: string, y: number}>} tiles
 * @param {Object} metrics - From shotPrepare / shotTagFixed.
 * @param {number} totalCss - Page height to render, in CSS px (already capped).
 */
async function composeTiles(tiles, metrics, totalCss) {
  const first = await decode(tiles[0].dataUrl);
  const innerWidth = metrics.innerWidth > 0 ? metrics.innerWidth : (metrics.viewportWidth || first.width);
  const innerHeight = metrics.innerHeight > 0 ? metrics.innerHeight : (metrics.viewportHeight || first.height);
  const scaleX = first.width / innerWidth;
  const scaleY = first.height / innerHeight;
  const viewportCssH = Math.max(1, metrics.viewportHeight);
  const viewportCssW = Math.max(1, metrics.viewportWidth || innerWidth);

  // Final height is what the tiles actually cover (tile cap may stop early).
  let coverageCss = 0;
  for (const t of tiles) coverageCss = Math.max(coverageCss, t.y + viewportCssH);
  const finalCss = Math.min(totalCss, coverageCss);

  const outW = Math.max(1, Math.round(viewportCssW * scaleX));
  const outH = Math.max(1, Math.round(finalCss * scaleY));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  let coveredCss = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const bitmap = i === 0 ? first : await decode(tile.dataUrl);
    try {
      const tileTop = tile.y;
      const tileBottom = tileTop + viewportCssH;
      if (tileBottom <= coveredCss) continue;

      const srcOffsetCss = Math.max(0, coveredCss - tileTop);
      const destYCss = tileTop + srcOffsetCss;
      const drawCss = Math.min(viewportCssH - srcOffsetCss, finalCss - destYCss);
      if (drawCss <= 0) continue;

      const srcY = Math.round(srcOffsetCss * scaleY);
      const srcH = Math.min(bitmap.height - srcY, Math.round(drawCss * scaleY));
      const destY = Math.round(destYCss * scaleY);
      if (srcH <= 0) continue;

      ctx.drawImage(bitmap, 0, srcY, outW, srcH, 0, destY, outW, srcH);
      coveredCss = destYCss + drawCss;
    } finally {
      bitmap.close();
    }
  }

  const dataUrl = await canvasToDataUrl(canvas);
  return { dataUrl, width: outW, height: outH };
}

// ---------------------------------------------------------------------------
// Chrome API helpers
// ---------------------------------------------------------------------------

async function getWindowId(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || typeof tab.windowId !== 'number') throw new Error('Could not resolve the tab window.');
  // captureVisibleTab grabs whichever tab is showing in the window. If the
  // studio was launched for a background tab (console hook, automation),
  // bring that tab forward first so the capture is of the right page.
  if (!tab.active) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(250);
    } catch (_) { /* best effort */ }
  }
  return tab.windowId;
}

function sendToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }).then((response) => {
    if (response && response.error) throw new Error(response.error);
    return response;
  });
}

/**
 * captureVisibleTab with spacing to respect the per-second quota. If Chrome
 * still rejects for quota, wait a full second and retry once.
 */
async function throttledCapture(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    lastCaptureAt = Date.now();
    if (!dataUrl) throw new Error('captureVisibleTab returned nothing.');
    return dataUrl;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/MAX_CAPTURE_VISIBLE_TAB|quota|exceeded/i.test(msg)) {
      await sleep(1100);
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      lastCaptureAt = Date.now();
      if (!dataUrl) throw new Error('captureVisibleTab returned nothing.');
      return dataUrl;
    }
    throw new Error('Capture failed: ' + msg);
  }
}

// ---------------------------------------------------------------------------
// Image helpers (service worker has no <img>/<canvas>; use blobs + bitmaps)
// ---------------------------------------------------------------------------

async function decode(dataUrl) {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  return createImageBitmap(blob);
}

async function canvasToDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not encode screenshot.'));
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return 'data:image/png;base64,' + btoa(binary);
  });
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
