/**
 * NetSuite TactaSuite - extension page smoke check (not a Playwright test file)
 *
 * @author Blane Maher
 *
 * Launches Chromium with the unpacked extension, opens the onboarding, options
 * and popup pages, and reports console errors, key DOM state and screenshots.
 * Run: node tests/extension-pages.check.mjs   (from the project root)
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'test-results', 'pages');
fs.mkdirSync(OUT, { recursive: true });
const userData = path.join(OUT, 'profile-' + Date.now());

const context = await chromium.launchPersistentContext(userData, {
  channel: 'chromium',
  headless: true,
  args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT],
  viewport: { width: 1100, height: 900 }
});

let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id:', extId, 'sw:', sw.url());

// First install must NOT open any tab; it seeds the User preset silently.
await new Promise((r) => setTimeout(r, 1500));
const autoOpened = context.pages().filter((p) => p.url().includes('onboarding'));
console.log('onboarding auto-opened on install:', autoOpened.length > 0);
if (autoOpened.length) { console.log('install should not open the onboarding tab'); process.exitCode = 1; }
const fresh = await sw.evaluate(() => chrome.storage.local.get(['tacta_user_type', 'featureStates']));
const freshOn = Object.values(fresh.featureStates || {}).filter(Boolean).length;
console.log('fresh install storage:', JSON.stringify({ userType: fresh.tacta_user_type, enabledCount: freshOn }));
if (fresh.tacta_user_type !== 'user') { console.log('fresh install should store user type "user"'); process.exitCode = 1; }

async function check(name, url, probe) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const state = await page.evaluate(probe);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  console.log('\n=== ' + name + ' (' + url.replace(extId, 'EXT') + ')');
  console.log('state:', JSON.stringify(state, null, 1));
  console.log('console errors/warnings:', errors.length ? errors : 'none');
  return { page, state, errors };
}

const base = 'chrome-extension://' + extId + '/';

const ob = await check('onboarding', base + 'onboarding/onboarding.html', () => ({
  title: document.title,
  counter: document.getElementById('obProgressCounter')?.textContent,
  stepChildren: document.getElementById('obStep')?.children.length,
  stepHeading: document.querySelector('#obStep h1')?.textContent,
  milestones: Array.from(document.querySelectorAll('#obMilestones li')).map((li) => li.textContent),
  scheme: document.documentElement.dataset.tactaTheme,
  bg: getComputedStyle(document.body).backgroundColor
}));

// Walk: Next -> choose Developer -> Next -> first feature page
await ob.page.click('#obNextBtn');
await ob.page.waitForTimeout(300);
const roleCards = await ob.page.$$('[data-user-type], .tacta-ob-role, button');
const devBtn = await ob.page.$('[data-user-type="developer"], [data-role="developer"]');
if (devBtn) { await devBtn.click(); await ob.page.waitForTimeout(400); }
const afterRole = await ob.page.evaluate(() => ({
  counter: document.getElementById('obProgressCounter')?.textContent,
  nextDisabled: document.getElementById('obNextBtn')?.disabled,
  heading: document.querySelector('#obStep h1')?.textContent
}));
console.log('after role step:', JSON.stringify(afterRole), 'role buttons found:', roleCards.length, 'devBtn:', !!devBtn);
if (!afterRole.nextDisabled) {
  await ob.page.click('#obNextBtn');
  await ob.page.waitForTimeout(400);
  const feat = await ob.page.evaluate(() => ({
    counter: document.getElementById('obProgressCounter')?.textContent,
    heading: document.querySelector('#obStep h1')?.textContent,
    toggles: document.querySelectorAll('#obStep input[type="checkbox"]').length,
    checked: document.querySelectorAll('#obStep input[type="checkbox"]:checked').length
  }));
  console.log('first feature page:', JSON.stringify(feat));
  await ob.page.screenshot({ path: path.join(OUT, 'onboarding-features.png'), fullPage: true });
}
const stored = await sw.evaluate(() => chrome.storage.local.get(['tacta_user_type', 'featureStates', 'tacta_onboarding_progress', 'tacta_theme_settings']));
console.log('storage after walk:', JSON.stringify({ userType: stored.tacta_user_type, progress: stored.tacta_onboarding_progress, enabledCount: Object.values(stored.featureStates || {}).filter(Boolean).length, theme: stored.tacta_theme_settings }));

const opt = await check('options', base + 'options/options.html', () => ({
  title: document.title,
  featureCards: document.querySelectorAll('.tacta-opt-feature-card').length,
  groups: Array.from(document.querySelectorAll('.tacta-opt-group-name')).map((e) => e.textContent),
  userType: document.getElementById('userTypeSelect')?.value,
  scheme: document.documentElement.dataset.tactaTheme,
  // Claude Desktop Bridge card (shared/bridge-settings-ui.js)
  bridgeBadge: document.querySelector('#bridge .tacta-opt-badge')?.textContent,
  bridgeEnable: !!document.getElementById('brEnabled'),
  bridgeSetupFirst: (() => {
    const card = document.getElementById('bridgeCard');
    const first = card && card.firstElementChild;
    // The setup block is first and starts collapsed (not open) on a fresh load.
    return !!(first && first.matches('details.tacta-br-setup') && !first.hasAttribute('open') && !first.open);
  })(),
  bridgeSnippets: document.querySelectorAll('#bridgeCard .tacta-br-snippet').length,
  bridgeSnippetHasExtId: (document.getElementById('brSnippetFull')?.textContent || '').includes(chrome.runtime.id),
  userTypeOptions: Array.from(document.querySelectorAll('#userTypeSelect option')).map((o) => o.value + (o.disabled ? '(disabled)' : '')),
  bridgeWriteWarning: !!document.querySelector('#bridgeCard .tacta-br-warn strong'),
  bridgeFaq: document.querySelectorAll('#bridgeCard .tacta-br-faq dt').length,
  feedbackButtons: document.querySelectorAll('[data-tacta-feedback]').length
}));
const optState = opt.state;
const optProblems = [];
if (!/beta/i.test(optState.bridgeBadge || '')) optProblems.push('bridge badge should say Beta: ' + optState.bridgeBadge);
if (!optState.bridgeEnable) optProblems.push('bridge enable switch missing');
if (!optState.bridgeSetupFirst) optProblems.push('bridge setup steps should be the first block in the card and start collapsed');
if (optState.bridgeSnippets < 3) optProblems.push('expected 3 config snippets (cases A, B, C), got ' + optState.bridgeSnippets);
if (!optState.bridgeSnippetHasExtId) optProblems.push('config snippet lacks the real extension id');
if (String(optState.userTypeOptions) !== 'user,developer,custom(disabled)') optProblems.push('user type select should offer user, developer and a disabled custom: ' + optState.userTypeOptions);
if (optState.userType !== 'developer') optProblems.push('options should show the Developer type chosen in the walkthrough: ' + optState.userType);
if (!optState.bridgeWriteWarning) optProblems.push('write-actions warning missing');
if (optState.bridgeFaq < 5) optProblems.push('FAQ too short: ' + optState.bridgeFaq);
if (optState.feedbackButtons < 2) optProblems.push('feedback buttons missing in About');
console.log('options assertions:', optProblems.length ? optProblems : 'all ok');
if (optProblems.length) process.exitCode = 1;

// Setup block: expand it, flip a bridge toggle (which re-renders the card), and
// confirm the block keeps the state the user left it in instead of snapping back.
const setupPersist = await opt.page.evaluate(async () => {
  const d = document.getElementById('brSetup');
  if (!d) return { ok: false, why: 'no #brSetup' };
  d.open = true;
  const multi = document.getElementById('brMultiAccount');
  if (!multi) return { ok: false, why: 'no #brMultiAccount' };
  multi.click();                                   // persist -> getBridgeSettings -> render
  await new Promise((r) => setTimeout(r, 600));
  const after = document.getElementById('brSetup');
  return { ok: true, stillOpen: !!(after && after.open) };
});
console.log('setup block persists open across a toggle:', JSON.stringify(setupPersist));
if (!setupPersist.ok || !setupPersist.stillOpen) { console.log('setup block collapse state not preserved on re-render'); process.exitCode = 1; }

// Feedback form opens and composes a mailto: with the message.
const fb = await opt.page.evaluate(() => {
  document.querySelector('[data-tacta-feedback="bug"]').click();
  const dlg = document.querySelector('.tacta-fb');
  if (!dlg) return { opened: false };
  document.getElementById('tactaFbTitleIn').value = 'Smoke test';
  document.getElementById('tactaFbDetails').value = 'Details here';
  const msg = window.TactaFeedback.buildMessage({ type: 'bug', title: 'Smoke test', details: 'Details here', includeTech: true, features: ['a'], userType: 'developer' });
  const target = window.TactaFeedback.targetUrl(msg);
  window.TactaFeedback.close();
  return { opened: true, kind: target.kind, urlStart: target.url.slice(0, 40), subjectOk: msg.subject.includes('Smoke test'), bodyHasVersion: /Extension: .* v\d/.test(msg.body) };
});
console.log('feedback form:', JSON.stringify(fb));
if (!fb.opened || !fb.subjectOk || !fb.bodyHasVersion) { console.log('feedback form assertions FAILED'); process.exitCode = 1; }

const pop = await check('popup', base + 'popup/popup.html', () => ({
  title: document.title,
  quickActions: document.querySelectorAll('.tacta-action-btn').length,
  groups: Array.from(document.querySelectorAll('.tacta-group-name')).map((e) => e.textContent),
  toggles: document.querySelectorAll('input[data-feature-id]').length,
  gear: !!document.getElementById('settingsToggle'),
  panelHidden: document.getElementById('settingsPanel')?.hasAttribute('hidden'),
  feedbackBtn: !!document.getElementById('feedbackBtn'),
  exportBtn: !!document.getElementById('exportSettingsBtn'),
  walkthroughLink: !!document.getElementById('runWalkthroughLink'),
  userTypeSegments: Array.from(document.querySelectorAll('#userTypeSegment [data-user-type]')).map((b) => b.dataset.userType + (b.disabled ? '(disabled)' : '') + (b.classList.contains('active') ? '*' : '')),
  version: document.querySelector('.tacta-version')?.textContent,
  scheme: document.documentElement.dataset.tactaTheme
}));
const popProblems = [];
if (!pop.state.feedbackBtn) popProblems.push('Send feedback button missing');
if (!pop.state.exportBtn) popProblems.push('Export settings button missing');
if (!pop.state.walkthroughLink) popProblems.push('setup walkthrough link missing');
if (String(pop.state.userTypeSegments) !== 'user,developer*,custom(disabled)') popProblems.push('user type segment should be user / developer (active) / custom (disabled): ' + pop.state.userTypeSegments);
// Flip one toggle: the type must become Custom; flipping it back must restore Developer.
await pop.page.setViewportSize({ width: 400, height: 600 });
await pop.page.click('#settingsToggle');
// The checkbox itself is visually hidden behind the toggle track, so click it
// programmatically (fires the same change event the delegated handler uses).
const clickFirstToggle = () => pop.page.evaluate(() => document.querySelector('input[data-feature-id]').click());
await clickFirstToggle();
await pop.page.waitForTimeout(300);
const afterToggle = await pop.page.evaluate(() => document.querySelector('#userTypeSegment .active')?.dataset.userType);
await clickFirstToggle();
await pop.page.waitForTimeout(300);
const afterRevert = await pop.page.evaluate(() => document.querySelector('#userTypeSegment .active')?.dataset.userType);
const storedType = await sw.evaluate(() => chrome.storage.local.get('tacta_user_type'));
console.log('popup user type after toggle / revert / stored:', afterToggle, afterRevert, storedType.tacta_user_type);
if (afterToggle !== 'custom') popProblems.push('toggling a feature should switch the type to custom, got ' + afterToggle);
if (afterRevert !== 'developer') popProblems.push('reverting the toggle should restore developer, got ' + afterRevert);
console.log('popup assertions:', popProblems.length ? popProblems : 'all ok');
if (popProblems.length) process.exitCode = 1;
// Gear panel and feedback form screenshots at popup width.
await pop.page.screenshot({ path: path.join(OUT, 'popup-gear.png'), fullPage: true });
await pop.page.click('#feedbackBtn');
await pop.page.waitForSelector('.tacta-fb', { timeout: 3000 });
await pop.page.screenshot({ path: path.join(OUT, 'popup-feedback.png'), fullPage: true });
console.log('popup gear + feedback screenshots taken');

await context.close();
console.log('\nscreenshots in', OUT);
