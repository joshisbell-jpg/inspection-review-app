/**
 * Inspection Review App - Main Process
 * 
 * This is the "backend" of the desktop app. It handles:
 * - Creating the app window
 * - Browser automation (fetching inspections)
 * - Claude API calls
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const {
  assembleV3Blob,
  transformV3ToV2ForDisplay,
  applyReviewerDecisions,
} = require('./review-v3');
const credentialStore = require('./credential-store');

// In packaged app, resources are in process.resourcesPath
// In dev, they're in the project root
const isPackaged = app.isPackaged;
const resourcesPath = isPackaged ? process.resourcesPath : __dirname.replace(/[/\\]src$/, '');

// Load .env from app directory (user places it next to the .exe or in resources)
const envPath = isPackaged
  ? path.join(path.dirname(app.getPath('exe')), '.env')
  : path.join(resourcesPath, '.env');
require('dotenv').config({ path: envPath });

// Point Playwright to bundled browsers
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(resourcesPath, 'playwright-browsers');

const { chromium } = require('playwright');

let mainWindow;
let browserInstance = null; // Playwright Browser object
let browser = null;         // Shared BrowserContext (all pages share cookies)

/**
 * Get or create the browser + shared context.
 * Uses chromium.launch() (NOT launchPersistentContext) to avoid
 * Windows crashes with user-data-dir locking (exitCode=2147483651).
 * Trade-off: login sessions don't persist between app restarts.
 */
async function getOrInitBrowser() {
  // Check if existing browser is still alive
  if (browserInstance?.isConnected() && browser) {
    return browser;
  }

  // Clean up stale references
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) {}
  }
  browser = null;
  browserInstance = null;

  browserInstance = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Single shared context so all pages share cookies after login
  browser = await browserInstance.newContext();

  browserInstance.on('disconnected', () => {
    console.log('Browser disconnected');
    browser = null;
    browserInstance = null;
  });

  return browser;
}

/**
 * Remove automation detection signals from a page before navigation.
 */
async function applyStealthMode(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete window.__playwright__;
    delete window.__pwInitScripts;
  });
}

// Create the main app window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset', // Nice look on Mac
    backgroundColor: '#f5f5f0'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) { /* already closed */ }
    browser = null;
    browserInstance = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ============================================
// IPC Handlers - Communication with the UI
// ============================================

// --------------------------------------------
// Auth IPC handlers (Mission 7.2 Phase B)
// --------------------------------------------
//
// electron-login takes {email, password}, posts to CRM_LOGIN_URL/api/auth/
// electron-login. On 200 it persists credentials.bin (encrypted) and
// preferences.json (plaintext lastEmail), and returns {success, user,
// organization}. On 401/403/409/423 it returns {success:false, status,
// error, lockedUntil?, remainingAttempts?}. Network failure → status 0.
//
// electron-logout reads creds, POSTs to serverWwwUrl/api/auth/electron-
// logout with Bearer plaintextKey, and ALWAYS clears credentials.bin
// regardless of server response — server-side failure must not strand
// the user logged in client-side.
//
// auth-state never exposes plaintextKey to the renderer. It returns
// either {authenticated: true, user, organization, serverWwwUrl} or
// {authenticated: false, lastEmail}.
//
// open-external-url whitelists URLs starting with the production CRM
// origin. On a non-matching URL it logs and returns silently — does NOT
// throw — so a misuse from the renderer doesn't surface as an unhandled
// promise rejection.

ipcMain.handle('electron-login', async (event, { email, password }) => {
  console.log('[auth] login attempt: ' + email);
  const loginUrl = process.env.CRM_LOGIN_URL || 'https://www.keepsimplecrm.com';

  let response;
  try {
    response = await fetch(`${loginUrl}/api/auth/electron-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    console.log('[auth] login failed: status=0 reason=network: ' + err.message);
    return { success: false, status: 0, error: 'NETWORK' };
  }

  let body = {};
  try {
    body = await response.json();
  } catch (e) {
    // body parse failure on non-200 is acceptable; on 200 it's a bug
    if (response.ok) {
      console.log('[auth] login failed: 200 with unparseable body');
      return { success: false, status: response.status, error: 'INVALID_RESPONSE' };
    }
  }

  if (!response.ok) {
    console.log(`[auth] login failed: status=${response.status} reason=${body.error || 'unknown'}`);
    return {
      success: false,
      status: response.status,
      error: body.error,
      lockedUntil: body.lockedUntil,
      remainingAttempts: body.remainingAttempts,
    };
  }

  // 200 path — persist creds and prefs.
  try {
    await credentialStore.writeCredentials({
      plaintextKey: body.plaintextKey,
      userId: body.user.id,
      userName: body.user.name,
      userEmail: body.user.email,
      organizationId: body.organization.id,
      organizationName: body.organization.name,
      serverWwwUrl: body.serverWwwUrl,
      createdAt: new Date().toISOString(),
    });
    await credentialStore.writePreferences({ lastEmail: email });
  } catch (err) {
    console.log('[auth] login success but credential persist failed: ' + err.message);
    return { success: false, status: 0, error: 'PERSIST_FAILED' };
  }

  console.log(`[auth] login success: userId=${body.user.id} orgId=${body.organization.id}`);
  return {
    success: true,
    user: { id: body.user.id, name: body.user.name, email: body.user.email },
    organization: { id: body.organization.id, name: body.organization.name },
  };
});

ipcMain.handle('electron-logout', async () => {
  const creds = await credentialStore.readCredentials();
  if (!creds) {
    return { success: true };
  }

  try {
    const response = await fetch(`${creds.serverWwwUrl}/api/auth/electron-logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.plaintextKey}` },
    });
    if (response.status !== 204) {
      console.log(`[auth] logout server returned ${response.status}, credentials cleared locally anyway`);
    }
  } catch (err) {
    console.log(`[auth] logout server unreachable, credentials cleared locally anyway: ${err.message}`);
  }

  await credentialStore.clearCredentials();
  console.log('[auth] logout success');
  return { success: true };
});

ipcMain.handle('auth-state', async () => {
  const creds = await credentialStore.readCredentials();
  if (creds) {
    return {
      authenticated: true,
      user: { id: creds.userId, name: creds.userName, email: creds.userEmail },
      organization: { id: creds.organizationId, name: creds.organizationName },
      serverWwwUrl: creds.serverWwwUrl,
    };
  }
  const prefs = await credentialStore.readPreferences();
  return { authenticated: false, lastEmail: prefs.lastEmail };
});

ipcMain.handle('open-external-url', async (event, url) => {
  // Whitelist: only the production CRM origin. Renderer should only ever
  // pass the forgot-password URL today.
  const ALLOWED_PREFIX = 'https://www.keepsimplecrm.com/';
  if (typeof url !== 'string' || !url.startsWith(ALLOWED_PREFIX)) {
    console.log(`[security] blocked openExternal to ${url}`);
    return;
  }
  await shell.openExternal(url);
});

// --------------------------------------------
// Existing handlers
// --------------------------------------------

/**
 * Initialize browser with user's existing session
 * This connects to their already-logged-in Chrome
 */
ipcMain.handle('init-browser', async () => {
  try {
    await getOrInitBrowser();
    return { success: true };
  } catch (error) {
    console.error('Browser init failed:', error.message);
    // Provide actionable advice
    let hint = '';
    if (error.message.includes('Target page, context or browser has been closed')) {
      hint = ' Try closing all Chrome windows and restarting the app.';
    } else if (error.message.includes('Failed to launch')) {
      hint = ' Make sure Google Chrome is installed, or close any existing Chrome windows.';
    }
    return { success: false, error: error.message + hint };
  }
});

/**
 * Open login pages for AppFolio and Zinspector
 * User logs in, then clicks "Continue" in the app
 */
ipcMain.handle('open-login-pages', async (event, urls) => {
  try {
    await getOrInitBrowser();

    const platforms = new Set();

    // Detect which platforms we need to login to
    for (const url of urls) {
      if (url.includes('appfolio.com')) platforms.add('appfolio');
      if (url.includes('zinspector.com')) platforms.add('zinspector');
    }

    // Open a tab for each platform (independent try/catch so one failure doesn't block the other)
    const pages = [];
    const results = {};

    if (platforms.has('appfolio')) {
      try {
        const page = await browser.newPage();
        await applyStealthMode(page);
        await page.goto('https://isbellrentals.appfolio.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
        pages.push({ platform: 'appfolio', page });
        results.appfolio = true;
      } catch (err) {
        console.error('AppFolio login page failed:', err.message);
        results.appfolio = false;
      }
    }

    if (platforms.has('zinspector')) {
      try {
        const page = await browser.newPage();
        await applyStealthMode(page);
        await page.goto('https://portfolio.zinspector.com/account/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        pages.push({ platform: 'zinspector', page });
        results.zinspector = true;
      } catch (err) {
        console.error('Zinspector login page failed:', err.message);
        results.zinspector = false;
      }
    }

    return { success: true, platforms: Array.from(platforms), results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Check if user is logged in to the platforms
 */
ipcMain.handle('check-login-status', async (event, urls) => {
  if (!browser) {
    return { success: false, error: 'Browser not initialized' };
  }

  try {
    const status = { appfolio: false, zinspector: false };
    
    // Check AppFolio
    const appfolioPage = await browser.newPage();
    await applyStealthMode(appfolioPage);
    await appfolioPage.goto('https://isbellrentals.appfolio.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // If we're NOT on a login page, we're logged in
    const appfolioUrl = appfolioPage.url();
    status.appfolio = !appfolioUrl.includes('/login') && !appfolioUrl.includes('/sign_in');
    await appfolioPage.close();

    // Check Zinspector
    const zinspectorPage = await browser.newPage();
    await applyStealthMode(zinspectorPage);
    await zinspectorPage.goto('https://portfolio.zinspector.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    const zinspectorUrl = zinspectorPage.url();
    status.zinspector = !zinspectorUrl.includes('/login') && !zinspectorUrl.includes('/account/login');
    await zinspectorPage.close();

    return { success: true, status };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Fetch inspection data from a URL
 */
ipcMain.handle('fetch-inspection', async (event, url) => {
  await getOrInitBrowser();

  let page;
  try {
    console.log(`[fetch-inspection] User pasted URL: ${url}`);

    page = await browser.newPage();
    await applyStealthMode(page);

    // Navigate directly to the user's URL
    console.log(`[fetch-inspection] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`[fetch-inspection] After domcontentloaded, URL is: ${page.url()}`);

    // Wait for dynamic content / redirects to settle
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log(`[fetch-inspection] After wait, final URL is: ${currentUrl}`);

    // If redirected away from the target URL, try navigating again
    if (currentUrl !== url && !currentUrl.includes('/report/') && !currentUrl.includes('/inspection')) {
      console.log(`[fetch-inspection] Redirected away! Retrying direct navigation...`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      console.log(`[fetch-inspection] After retry, URL is: ${page.url()}`);
    }

    // Check if we hit a login page
    const finalUrl = page.url();
    if (finalUrl.includes('/login') || finalUrl.includes('/sign_in') || finalUrl.includes('/account/login')) {
      console.log(`[fetch-inspection] Hit login page: ${finalUrl}`);
      await page.close();
      return {
        success: false,
        error: 'LOGIN_REQUIRED',
        message: 'Please log in to this platform first',
        platform: detectPlatform(url)
      };
    }

    // Detect which platform we're on
    const platform = detectPlatform(url);
    if (platform === 'unknown') {
      throw new Error('Unsupported inspection platform');
    }

    console.log(`[fetch-inspection] Extracting data from: ${page.url()} (platform: ${platform})`);

    // Universal screenshot-based extraction (works for any platform)
    const data = await extractInspectionData(page, platform);

    await page.close();
    return { success: true, data };

  } catch (error) {
    if (page) await page.close().catch(() => {});
    
    // Better error messages
    if (error.message.includes('Timeout')) {
      return { 
        success: false, 
        error: 'TIMEOUT',
        message: 'Page took too long to load. You may need to log in first.',
        platform: detectPlatform(url)
      };
    }
    
    return { success: false, error: error.message };
  }
});

/**
 * Call the KeepSimpleCRM AI analysis proxy.
 *
 * Mission 7.2 Phase D: replaces direct Anthropic SDK use in the Electron
 * client. The server proxy (POST /api/inspections/ai-analyze) holds
 * ANTHROPIC_API_KEY; distributed installers no longer ship it. Auth is the
 * per-user CRM API key issued at electron-login (Mission 7.2 Phase A) and
 * persisted via safeStorage (Phase B). Model + max_tokens are fixed
 * server-side, so future model upgrades are a one-line CRM change with no
 * Electron rebuild.
 *
 * Errors carry a typed `.code` so analyze-inspections can branch:
 *   NOT_AUTHENTICATED — no creds on disk; renderer should already be on the
 *                       login screen (auth-expired event also emitted).
 *   AUTH_EXPIRED      — server returned 401 (key revoked mid-session);
 *                       creds wiped, auth-expired emitted.
 *   NETWORK_ERROR     — fetch threw (DNS/refused/offline).
 *   (no .code)        — proxy 4xx/5xx with .message for the UI.
 */
async function callClaude(anthropicMessages) {
  const creds = await credentialStore.readCredentials();
  if (!creds) {
    // Mirrors the send-to-crm pre-flight: if creds vanished mid-session,
    // surface as auth-expired so the renderer routes back to login.
    mainWindow?.webContents.send('auth-expired');
    const e = new Error('Not authenticated');
    e.code = 'NOT_AUTHENTICATED';
    throw e;
  }

  const totalInputChars = anthropicMessages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + m.content.length;
    if (Array.isArray(m.content)) return sum + m.content.reduce((s, c) => s + (c.text?.length || 0), 0);
    return sum;
  }, 0);
  console.log(`[ai-review] sending ~${totalInputChars} chars (~${Math.ceil(totalInputChars / 4)} tokens) to AI proxy`);

  let response;
  try {
    response = await fetch(`${creds.serverWwwUrl}/api/inspections/ai-analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.plaintextKey}`,
      },
      body: JSON.stringify({ messages: anthropicMessages }),
    });
  } catch (networkErr) {
    const e = new Error(`Network error contacting AI proxy: ${networkErr.message}`);
    e.code = 'NETWORK_ERROR';
    throw e;
  }

  if (response.status === 401) {
    // Mirror of the send-to-crm 401 handler: server says this key is no
    // longer valid → wipe disk creds + prompt re-login. The renderer's
    // onAuthExpired callback does NOT reset in-memory inspection state, so
    // the user can re-login and re-run analysis with their work intact.
    console.log('[auth] 401 detected during ai-analyze — clearing credentials, prompting re-login');
    await credentialStore.clearCredentials();
    mainWindow?.webContents.send('auth-expired');
    const e = new Error('Auth expired');
    e.code = 'AUTH_EXPIRED';
    throw e;
  }

  if (!response.ok) {
    // 4xx (other than 401) and 5xx: proxy returns {error, anthropicStatus,
    // anthropicMessage}. anthropicMessage is the most actionable detail when
    // present (e.g., content-policy reject); fall back to error / status.
    const errBody = await response.json().catch(() => ({}));
    const detail = errBody.anthropicMessage || errBody.error || `HTTP ${response.status}`;
    throw new Error(detail);
  }

  const data = await response.json();
  console.log('[ai-review] AI proxy response received');
  return data.text;
}

/**
 * Process inspections — Mission 3 Phase 2 V3 categorization with V2 soft fallback.
 *
 * Format selection (env var, default 'v3'):
 *   AI_REVIEW_FORMAT=v3  → V3 prompt → assemble V3IssuesBlob → V2-flat _displayShape.
 *                          On any V3 path failure, fall through to V2 (separate API call).
 *   AI_REVIEW_FORMAT=v2  → V2 prompt only (legacy behavior).
 *
 * Soft-fallback rationale: a V3 failure costs ~$1-3 wasted on the failed call before
 * V2 succeeds. Acceptable; bounded. Caller telemetry surfaces the failure cause.
 */
ipcMain.handle('analyze-inspections', async (event, { newInspection, previousInspections, context }) => {
  const aiReviewFormat = (process.env.AI_REVIEW_FORMAT || 'v3').toLowerCase();
  const thresholdRaw = Number(process.env.AI_REVIEW_CONFIDENCE_THRESHOLD);
  const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 0.7;
  const debug = process.env.AI_REVIEW_DEBUG === 'true';
  const isComparisonMode = Array.isArray(previousInspections) && previousInspections.length > 0;

  // V3 attempt with soft fallback
  if (aiReviewFormat === 'v3') {
    try {
      if (debug) console.log(`[ai-review] V3 prompt — comparison=${isComparisonMode}, threshold=${threshold}`);
      const v3Messages = isComparisonMode
        ? buildV3ComparisonMessages(newInspection, previousInspections, context)
        : buildV3SingleInspectionMessages(newInspection, context);

      const rawV3Response = await callClaude(v3Messages);
      if (debug) console.log('[ai-review] V3 raw response (first 2000 chars):', rawV3Response.substring(0, 2000));

      const parsedAi = parseAnalysisResponse(rawV3Response);
      if (!parsedAi || !Array.isArray(parsedAi.issues)) {
        throw new Error('V3 prompt returned non-array issues');
      }

      const v3Blob = assembleV3Blob(parsedAi.issues, isComparisonMode, threshold, parsedAi.utilityStatus);
      const displayShape = transformV3ToV2ForDisplay(
        v3Blob,
        parsedAi.overall_condition,
        parsedAi.summary,
        isComparisonMode,
      );

      if (debug) {
        const fallbackCount = countByPredicate(v3Blob, (i) => i.bucketAssignedBy === 'deterministic-fallback');
        console.log(`[ai-review] V3 assembly — total=${v3Blob.totalIssues}, ` +
          `cleaning=${groupIssueCount(v3Blob.buckets.cleaning)}, ` +
          `make_ready=${groupIssueCount(v3Blob.buckets.make_ready)}, ` +
          `exterior=${groupIssueCount(v3Blob.buckets.exterior)}, ` +
          `keyword_fallback=${fallbackCount}`);
        console.log(`[ai-review] V3 → V2 display: ${displayShape.issues.length} rows with _v3Id mapping`);
      }

      return {
        success: true,
        result: {
          format: 'v3',
          overall_condition: parsedAi.overall_condition,
          summary: parsedAi.summary,
          issues: v3Blob,
          _displayShape: displayShape,
        },
      };
    } catch (v3Error) {
      // Auth errors short-circuit: V2 would fail identically through the same
      // proxy, so a fallback would just waste another doomed call. Surface
      // the typed code; the renderer's auth-expired handler is already routing
      // to the login screen, so no generic alert is needed.
      if (v3Error.code === 'AUTH_EXPIRED' || v3Error.code === 'NOT_AUTHENTICATED') {
        return { success: false, error: v3Error.code };
      }
      // ALWAYS log this — not gated on debug.
      console.warn('[ai-review] V3 emission failed — falling back to V2:', v3Error.message);
      // fall through to V2 path
    }
  }

  // V2 path (default when AI_REVIEW_FORMAT=v2, or fallback after V3 failure)
  try {
    if (debug) console.log(`[ai-review] V2 prompt — comparison=${isComparisonMode}`);
    const v2Messages = buildComparisonMessages(newInspection, previousInspections, context);
    const rawV2Response = await callClaude(v2Messages);
    if (debug) console.log('[ai-review] V2 raw response (first 2000 chars):', rawV2Response.substring(0, 2000));

    const result = parseAnalysisResponse(rawV2Response);
    result.format = 'v2'; // explicit so send-to-crm can branch
    return { success: true, result };
  } catch (error) {
    // Surface typed auth codes so the renderer can suppress the generic
    // alert (auth-expired event already routed it to the login screen).
    if (error.code === 'AUTH_EXPIRED' || error.code === 'NOT_AUTHENTICATED') {
      return { success: false, error: error.code };
    }
    return { success: false, error: error.message };
  }
});

/**
 * Helpers for V3 telemetry — kept tiny and local since they only exist for debug logs.
 */
function groupIssueCount(groups) {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((sum, g) => sum + (g.issues?.length || 0), 0);
}
function countByPredicate(v3Blob, predicate) {
  let n = 0;
  for (const bucketName of ['cleaning', 'make_ready', 'exterior']) {
    for (const group of v3Blob.buckets[bucketName] || []) {
      for (const issue of group.issues || []) if (predicate(issue)) n += 1;
    }
  }
  for (const issue of v3Blob.manualIssues || []) if (predicate(issue)) n += 1;
  return n;
}

/**
 * Send inspection data + results to KeepSimpleCRM
 */
ipcMain.handle('send-to-crm', async (event, { currentInspection, previousInspections, context, result, reviewerDecisions }) => {
  try {
    // Mission 7.2 Phase B: read auth state from safeStorage instead of .env.
    // crmUrl now comes from the serverWwwUrl returned by /api/auth/electron-
    // login (locked at login time, defends against URL drift). Plaintext key
    // is the per-user CRM API key issued by that same login response.
    const creds = await credentialStore.readCredentials();
    if (!creds) {
      // Defensive: the renderer should have prompted a login before we ever
      // got called, but if creds vanished mid-session (manual file delete,
      // disk error), surface as auth-expired so the renderer falls back to
      // the login screen. See B6 onAuthExpired handler — that handler does
      // NOT clear in-memory inspection state. Two different surfaces, two
      // different lifetimes — disk vs renderer memory.
      mainWindow?.webContents.send('auth-expired');
      return { success: false, error: 'NOT_AUTHENTICATED' };
    }
    const crmUrl = creds.serverWwwUrl;
    const crmToken = creds.plaintextKey;
    const debug = process.env.AI_REVIEW_DEBUG === 'true';

    // Build the analysisResult payload based on format. V3 bakes reviewer
    // decisions into the V3IssuesBlob and omits the top-level reviewerDecisions
    // array. V2 keeps the existing shape (preprocess on the CRM side injects
    // format='v2').
    let analysisResultPayload;
    let reviewerDecisionsPayload;

    if (result && result.format === 'v3') {
      const displayedIssues = (result._displayShape && result._displayShape.issues) || [];

      // Unconditional integrity warn (round-robin fix #1, item #4): if format=v3 but
      // _displayShape is missing or empty while there are reviewer decisions to apply,
      // we'd silently lose every decision. Surface this as an internal-bug signal even
      // when AI_REVIEW_DEBUG is off — this is a data-integrity warning, not telemetry.
      const hasDecisions = Array.isArray(reviewerDecisions) && reviewerDecisions.some(d => {
        const v = typeof d === 'string' ? d : (d && d.decision);
        return v && v !== 'unreviewed';
      });
      if (hasDecisions && displayedIssues.length === 0) {
        console.warn('[ai-review] V3 save: result marked v3 but _displayShape is missing or empty — ' +
          'reviewer decisions will not be applied. This indicates an internal bug in analyze-inspections.');
      }

      const { blob: finalV3Blob, mappedCount, unmappedCount } = applyReviewerDecisions(
        result.issues,
        reviewerDecisions,
        displayedIssues,
      );

      // Unconditional data-loss warn (round-robin fix #2, item #5/#6): unmappedCount
      // means the user clicked a decision but it landed nowhere. Always surface this,
      // not just under debug — silent decision loss is exactly what the human reviewer
      // is paid to prevent.
      if (unmappedCount > 0) {
        console.warn(`[ai-review] ${unmappedCount} reviewer decision(s) failed to map to V3 issues by _v3Id — ` +
          `decisions LOST. Likely cause: _v3Id mismatch between display shape sent to renderer and V3 blob in main.`);
      }

      if (debug) {
        console.log(`[ai-review] V3 reviewer decisions applied: mapped=${mappedCount}, unmapped=${unmappedCount}`);
        console.log('[ai-review] V3 payload format=v3, totalIssues=' + finalV3Blob.totalIssues +
          ', skipped=' + finalV3Blob.totalSkipped + ', unreviewed=' + finalV3Blob.totalUnreviewed);
      }
      analysisResultPayload = {
        format: 'v3',
        overall_condition: result.overall_condition,
        summary: result.summary,
        issues: finalV3Blob,
      };
      reviewerDecisionsPayload = undefined; // baked into V3 issues
    } else {
      // V2 path — unchanged shape from before this PR (CRM preprocess injects format='v2')
      analysisResultPayload = result;
      reviewerDecisionsPayload = reviewerDecisions;
      if (debug) console.log('[ai-review] V2 payload — issues=' + ((result && result.issues && result.issues.length) || 0));
    }

    const body = {
      address: context.address || currentInspection.property?.address,
      unit: context.unit || currentInspection.property?.unit,
      tenantName: context.tenant || currentInspection.property?.tenant,
      securityDeposit: context.deposit ? Number(context.deposit) : undefined,
      leaseDuration: context.leaseDuration,
      currentInspectionUrl: currentInspection.url,
      previousInspectionUrls: previousInspections.map(p => p.url),
      currentInspectionData: currentInspection,
      previousInspectionsData: previousInspections,
      analysisResult: analysisResultPayload,
    };
    if (reviewerDecisionsPayload !== undefined) {
      body.reviewerDecisions = reviewerDecisionsPayload;
    }

    const response = await fetch(`${crmUrl}/api/inspections/ai-review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${crmToken}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      // Server says this key is no longer valid — wipe it on disk and tell
      // the renderer to switch to the login screen. The renderer must NOT
      // reset in-memory inspection state on auth-expired; the user should be
      // able to re-login and click Save to CRM again with their decisions
      // intact. See B6 for the renderer-side preservation contract.
      console.log('[auth] 401 detected during send-to-crm — clearing credentials, prompting re-login');
      await credentialStore.clearCredentials();
      mainWindow?.webContents.send('auth-expired');
      return { success: false, error: 'AUTH_EXPIRED' };
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: err.error || `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Parse a PDF file and extract inspection text
ipcMain.handle('parse-pdf', async (event, filePath) => {
  try {
    // pdf-parse v1.1.1 — pure Node.js, no canvas/DOMMatrix needed
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const text = data.text || '';
    console.log(`[parse-pdf] extracted ${text.length} chars from ${data.numpages} pages`);

    // Detect platform from PDF content
    let platform = 'unknown';
    if (text.toLowerCase().includes('zinspector') || text.toLowerCase().includes('condition summary')) {
      platform = 'zinspector';
    } else if (text.toLowerCase().includes('appfolio')) {
      platform = 'appfolio';
    }

    const { address, source: addressSource } = extractPropertyAddress(text, platform);

    return {
      success: true,
      data: {
        platform,
        url: filePath,
        screenshots: [],     // No screenshots for PDF
        photos: [],           // No photos for PDF
        tableData: [],        // No DOM table data for PDF
        property: { address },
        addressSource,
        textContent: text,
        pageCount: data.numpages || 0,
        extractedAt: new Date().toISOString(),
        source: 'pdf'
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// Helper Functions
// ============================================

/**
 * Extract property address from PDF text using format-aware strategies.
 *
 * Returns { address: string, source: 'appfolio' | 'zinspector' | 'fallback' | 'empty' }.
 * The source identifies which strategy matched, used by the renderer to badge
 * extraction confidence. Falls back to legacy naive regex if format-specific
 * extraction fails — Mission 2.5c added a human-editable field as the safety net.
 */
function extractPropertyAddress(text, platform) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const head = lines.slice(0, 30);

  // Strategy 1: AppFolio "Property:..." line
  if (platform === 'appfolio') {
    for (const line of head) {
      const m = line.match(/^Property\s*:\s*(.+)$/i);
      if (m && m[1].trim().length > 0 && m[1].trim().length < 200) {
        const result = m[1].trim();
        console.log(`[parse-pdf] address via AppFolio Property: prefix → ${result}`);
        return { address: result, source: 'appfolio' };
      }
    }
  }

  // Strategy 2: zInspector "PropertyTenant(s)Date..." header table
  if (platform === 'zinspector') {
    for (let i = 0; i < head.length - 1; i++) {
      if (/^Property\s*Tenant\(s\)\s*Date\s*Agent/i.test(head[i])) {
        const dataLine = head[i + 1];
        const dateMatch = dataLine.match(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})/);
        if (dateMatch && dateMatch.index > 0) {
          const result = dataLine.slice(0, dateMatch.index).trim();
          if (result.length > 0 && result.length < 200) {
            console.log(`[parse-pdf] address via zInspector property table → ${result}`);
            return { address: result, source: 'zinspector' };
          }
        }
      }
    }
  }

  // Fallback: legacy naive regex (better wrong than empty)
  for (const line of lines.slice(0, 20)) {
    if (/^\d+\s+\w/.test(line) && line.length < 100) {
      console.warn(`[parse-pdf] address via legacy fallback regex (may be wrong) → ${line}`);
      return { address: line, source: 'fallback' };
    }
  }

  console.warn('[parse-pdf] no address extracted');
  return { address: '', source: 'empty' };
}

function detectPlatform(url) {
  if (url.includes('appfolio.com')) return 'appfolio';
  if (url.includes('zinspector.com')) return 'zinspector';
  return 'unknown';
}

/**
 * Resize a base64 JPEG image if either dimension exceeds maxPx.
 * Uses an offscreen canvas in the browser page context.
 */
async function resizeImageIfNeeded(page, base64, mediaType, maxPx = 7000) {
  return await page.evaluate(async ({ b64, mt, max }) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (img.width <= max && img.height <= max) {
          resolve({ base64: b64, mediaType: mt }); // no resize needed
          return;
        }
        const scale = Math.min(max / img.width, max / img.height);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const resized = canvas.toDataURL('image/jpeg', 0.80).split(',')[1];
        resolve({ base64: resized, mediaType: 'image/jpeg' });
      };
      img.onerror = () => resolve({ base64: b64, mediaType: mt });
      img.src = 'data:' + mt + ';base64,' + b64;
    });
  }, { b64: base64, mt: mediaType, max: maxPx });
}

/**
 * Take viewport-sized screenshots while scrolling down the page.
 * Returns array of base64 JPEG strings.
 * @param {number} maxShots - max screenshots to take
 * @param {number} scrollStep - pixels to scroll between shots (defaults to viewport height)
 */
async function takeScrollingScreenshots(page, maxShots = 4, scrollStep = 0) {
  const screenshots = [];
  const viewportHeight = page.viewportSize().height;
  const step = scrollStep || viewportHeight;
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  const possibleSteps = Math.ceil(totalHeight / step);
  const steps = Math.min(maxShots, possibleSteps);

  console.log(`[screenshots] Page height: ${totalHeight}px, viewport: ${viewportHeight}px, step: ${step}px, taking ${steps} of ${possibleSteps} possible screenshots`);

  for (let i = 0; i < steps; i++) {
    const scrollY = i * step;
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(400);
    const shot = await page.screenshot({ type: 'jpeg', quality: 70 });
    screenshots.push(shot.toString('base64'));
  }

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  return screenshots;
}

/**
 * Extract the structured Condition Summary table from a Zinspector report.
 * Returns an array of row objects with: room, detail, condition, actions, comment, hasMedia.
 * This captures ALL issues in the report, regardless of page count.
 */
async function extractZinspectorTableData(page) {
  console.log('=== ZINSPECTOR TABLE EXTRACTION START ===');

  // Scroll through entire page to ensure lazy-loaded content is rendered
  const scrollInfo = await page.evaluate(async () => {
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    let totalHeight = document.body.scrollHeight;
    let lastHeight = 0;
    // Scroll in steps, wait for content to load, re-check height
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < totalHeight; y += 400) {
        window.scrollTo(0, y);
        await delay(100);
      }
      await delay(500);
      const newHeight = document.body.scrollHeight;
      if (newHeight === lastHeight) break;
      lastHeight = totalHeight;
      totalHeight = newHeight;
    }
    window.scrollTo(0, 0);
    return { scrollHeight: totalHeight };
  });
  await page.waitForTimeout(1000);
  console.log(`[zinspector] Page scrollHeight: ${scrollInfo.scrollHeight}px`);

  // Step 1: Diagnostic — dump raw DOM structure to understand what we're working with
  const diagnostic = await page.evaluate(() => {
    const info = {
      tables: 0,
      tableDetails: [],
      divTables: 0,
      totalTrs: 0,
      bodyClasses: document.body.className,
      firstTableHtml: '',
    };

    const tables = document.querySelectorAll('table');
    info.tables = tables.length;

    tables.forEach((table, idx) => {
      const trs = table.querySelectorAll('tr');
      const firstRowCells = trs[0] ? Array.from(trs[0].querySelectorAll('td, th')).map(c => c.textContent.trim()) : [];
      info.tableDetails.push({
        index: idx,
        rows: trs.length,
        firstRowCells: firstRowCells.slice(0, 8),
        className: table.className,
        parentClass: table.parentElement?.className || '',
      });
      info.totalTrs += trs.length;
    });

    // Check for div-based table patterns
    const divRows = document.querySelectorAll('[class*="row"], [role="row"]');
    info.divTables = divRows.length;

    // Grab first table's outer HTML (truncated) for inspection
    if (tables[0]) {
      info.firstTableHtml = tables[0].outerHTML.substring(0, 2000);
    }

    return info;
  });

  console.log(`[zinspector] DOM Diagnostic:`);
  console.log(`  <table> elements: ${diagnostic.tables}`);
  console.log(`  Total <tr> elements: ${diagnostic.totalTrs}`);
  console.log(`  Div-based rows: ${diagnostic.divTables}`);
  console.log(`  Body classes: "${diagnostic.bodyClasses}"`);
  diagnostic.tableDetails.forEach(t => {
    console.log(`  Table #${t.index}: ${t.rows} rows, class="${t.className}", parent="${t.parentClass}"`);
    console.log(`    First row cells: ${JSON.stringify(t.firstRowCells)}`);
  });
  if (diagnostic.tables === 0) {
    console.log(`  First table HTML: NONE`);
    console.log(`  Checking first 500 chars of body HTML for structure clues...`);
    const bodySnippet = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
    console.log(`  Body snippet: ${bodySnippet}`);
  }

  // Step 2: Extract table data with robust parsing
  const tableData = await page.evaluate(() => {
    const rows = [];
    let currentRoom = '';
    const debug = [];

    const allTables = document.querySelectorAll('table');
    debug.push(`Found ${allTables.length} tables`);

    for (const table of allTables) {
      const trs = table.querySelectorAll('tr');
      debug.push(`Table has ${trs.length} rows`);

      for (let trIdx = 0; trIdx < trs.length; trIdx++) {
        const tr = trs[trIdx];
        const cells = tr.querySelectorAll('td, th');
        const cellTexts = Array.from(cells).map(c => c.textContent.trim());

        // Skip rows with fewer than 2 cells
        if (cells.length < 2) {
          // But check for room header (single merged cell)
          if (cells.length === 1 && cellTexts[0]) {
            const text = cellTexts[0];
            // Room headers are typically short labels like "Kitchen", "Bedroom 1", etc.
            if (text.length < 50 && !text.includes('\n')) {
              currentRoom = text;
              debug.push(`Room header (single cell): "${currentRoom}"`);
            }
          }
          continue;
        }

        // Skip entirely empty rows
        if (cellTexts.every(t => t === '')) continue;

        // Detect header rows: ALL cells must be header-like words (not just one matching)
        const headerWords = ['area', 'detail', 'condition', 'actions', 'comment', 'media', 'status', 'notes', 'description', 'item'];
        const headerMatches = cellTexts.filter(t => headerWords.includes(t.toLowerCase()));
        if (headerMatches.length >= 2) {
          debug.push(`Header row (${headerMatches.length} matches): ${JSON.stringify(cellTexts.slice(0, 6))}`);
          continue;
        }

        // Detect room header: first cell has content, all others empty, and looks like a room name
        const nonEmptyCells = cellTexts.filter(t => t !== '');
        if (nonEmptyCells.length === 1 && cellTexts[0] && cellTexts[0].length < 60) {
          currentRoom = cellTexts[0];
          debug.push(`Room header (row): "${currentRoom}"`);
          continue;
        }

        // Check if first cell is bold (room name embedded in data row)
        const firstCell = cells[0];
        const fontWeight = parseInt(window.getComputedStyle(firstCell).fontWeight, 10);
        const hasBoldTag = !!firstCell.querySelector('b, strong');
        if ((hasBoldTag || fontWeight >= 600) && cellTexts[0] && cellTexts[0].length < 50) {
          currentRoom = cellTexts[0];
        }

        // Parse based on column count — be permissive, keep everything
        let row = null;
        if (cells.length >= 6) {
          // Full row: Area | Detail | Condition | Actions | Comment | Media
          row = {
            room: currentRoom || cellTexts[0],
            detail: cellTexts[1] || '',
            condition: cellTexts[2] || '',
            actions: cellTexts[3] || '',
            comment: cellTexts[4] || '',
            hasMedia: (cellTexts[5] || '').toLowerCase().includes('image') ||
                      !!cells[5]?.querySelector('a'),
          };
        } else if (cells.length >= 5) {
          row = {
            room: currentRoom || cellTexts[0],
            detail: cellTexts[1] || '',
            condition: cellTexts[2] || '',
            actions: cellTexts[3] || '',
            comment: cellTexts[4] || '',
            hasMedia: false,
          };
        } else if (cells.length >= 4) {
          row = {
            room: currentRoom || cellTexts[0],
            detail: cellTexts[1] || '',
            condition: cellTexts[2] || '',
            actions: '',
            comment: cellTexts[3] || '',
            hasMedia: false,
          };
        } else if (cells.length >= 3) {
          row = {
            room: currentRoom || cellTexts[0],
            detail: cellTexts[1] || '',
            condition: '',
            actions: '',
            comment: cellTexts[2] || '',
            hasMedia: false,
          };
        } else if (cells.length >= 2) {
          row = {
            room: currentRoom || cellTexts[0],
            detail: '',
            condition: '',
            actions: '',
            comment: cellTexts[1] || '',
            hasMedia: false,
          };
        }

        if (row && (row.detail || row.comment || row.condition)) {
          rows.push(row);
          if (rows.length <= 10) {
            debug.push(`Row ${rows.length}: ${row.room} | ${row.detail} | ${row.condition} | ${row.comment.substring(0, 60)}`);
          }
        }
      }
    }

    // Strategy 2: If no table rows found, extract ALL visible text in a structured way
    if (rows.length === 0) {
      debug.push('No <table> rows found. Trying text extraction...');

      // Get the entire page text content, broken by sections
      const allText = document.body.innerText;
      const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      debug.push(`Page has ${lines.length} non-empty text lines`);

      // Look for patterns: lines that look like condition items
      let room = '';
      for (const line of lines) {
        // Room headers are typically standalone short lines (< 40 chars, no pipe/tab)
        if (line.length < 40 && !line.includes('\t') && !line.includes('|') &&
            !line.match(/^(S|P|N\/A|None|Image|Satisfactory|Poor|Good|Fair)$/i)) {
          // Heuristic: capitalize-heavy short lines are room names
          const words = line.split(' ');
          const capitalWords = words.filter(w => w[0] === w[0]?.toUpperCase());
          if (capitalWords.length === words.length && words.length <= 5) {
            room = line;
            continue;
          }
        }

        // Tab-separated or pipe-separated data lines
        let parts = line.includes('\t') ? line.split('\t') : null;
        if (!parts) parts = line.includes('|') ? line.split('|') : null;

        if (parts && parts.length >= 3) {
          const cleaned = parts.map(p => p.trim());
          rows.push({
            room: room || cleaned[0],
            detail: cleaned[1] || '',
            condition: cleaned[2] || '',
            actions: cleaned[3] || '',
            comment: cleaned.slice(4).join(' ').trim(),
            hasMedia: line.toLowerCase().includes('image'),
          });
        }
      }
      debug.push(`Text extraction found ${rows.length} rows`);
    }

    return { rows, debug };
  });

  // Log debug info from inside page.evaluate
  tableData.debug.forEach(msg => console.log(`[zinspector]   ${msg}`));
  const rows = tableData.rows;

  console.log(`=== ZINSPECTOR TABLE EXTRACTION END: ${rows.length} rows ===`);
  return rows;
}

/**
 * Extract photo URLs from Zinspector report pages.
 * Zinspector puts "Image" links in the Media column that link to actual photos.
 */
async function extractZinspectorPhotoUrls(page) {
  // Page already scrolled by extractZinspectorTableData, just grab URLs
  const photoUrls = await page.evaluate(() => {
    const urls = new Set();

    // Look for links that contain "Image" text (Zinspector Media column)
    document.querySelectorAll('a').forEach(a => {
      const text = a.textContent.trim().toLowerCase();
      const href = a.href || '';
      if ((text === 'image' || text === 'photo' || text === 'view') && href && !href.includes('javascript:')) {
        urls.add(href);
      }
      if (href.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        urls.add(href);
      }
    });

    // Look for actual inspection photo images
    document.querySelectorAll('img').forEach(img => {
      if (!img.src || img.src.startsWith('data:')) return;
      if (img.naturalWidth < 100 || img.naturalHeight < 100) return;
      if (img.src.includes('logo') || img.src.includes('icon') || img.src.includes('avatar')) return;
      const fullUrl = img.dataset.src || img.dataset.original || img.dataset.fullUrl || '';
      if (fullUrl) urls.add(fullUrl);
      urls.add(img.src);
    });

    return [...urls];
  });

  console.log(`[zinspector] Found ${photoUrls.length} potential photo URLs`);
  return photoUrls;
}

/**
 * Download a photo URL as base64 from within the page context.
 */
async function downloadPhotoAsBase64(page, url) {
  return await page.evaluate(async (imgUrl) => {
    try {
      const resp = await fetch(imgUrl, { credentials: 'include' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) return null;
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }, url);
}

/**
 * Universal inspection data extractor.
 * Scrolls page, takes viewport screenshots, extracts actual photo URLs, downloads them.
 */
async function extractInspectionData(page, platform) {
  console.log(`[extract] Starting extraction on: ${page.url()}`);

  // Wait for page to fully load
  try {
    await page.waitForLoadState('networkidle', { timeout: 30000 });
  } catch (e) {
    console.log('[extract] networkidle timeout, continuing anyway');
  }
  await page.waitForTimeout(3000);
  console.log(`[extract] After full load, URL is: ${page.url()}`);

  // 1. For Zinspector: try to extract structured table data (bonus data, not relied upon)
  let tableData = [];
  if (platform === 'zinspector') {
    tableData = await extractZinspectorTableData(page);
    console.log(`[extract] Zinspector table: ${tableData.length} rows extracted (supplementary)`);

    // Validate: filter to rows that look like actual inspection data (have condition or meaningful comment)
    const inspectionKeywords = ['poor', 'good', 'fair', 'satisfactory', 'damage', 'stain', 'scratch', 'dent', 'broken', 'missing', 'dirty', 'clean', 'worn'];
    const meaningfulRows = tableData.filter(row => {
      const text = `${row.condition} ${row.comment} ${row.detail}`.toLowerCase();
      return inspectionKeywords.some(kw => text.includes(kw));
    });
    console.log(`[extract] Zinspector meaningful inspection rows: ${meaningfulRows.length} of ${tableData.length}`);

    if (meaningfulRows.length === 0) {
      console.warn('[extract] Zinspector URL scraping found no inspection data — likely picked up calendar/UI tables');
      throw new Error('Zinspector URL scraping found no inspection data. Please use PDF upload instead for reliable results.');
    }
  }

  // 2. Take scrolling viewport screenshots
  // Zinspector: take MANY screenshots (10-15) to capture the full condition summary
  // Other platforms: take 4 screenshots
  let screenshots;
  if (platform === 'zinspector') {
    // Scroll with 800px steps to capture detail, up to 15 screenshots
    screenshots = await takeScrollingScreenshots(page, 40, 800);
  } else {
    screenshots = await takeScrollingScreenshots(page, 20);
  }
  console.log(`[extract] Captured ${screenshots.length} viewport screenshots`);

  // 3. Extract photo URLs based on platform
  let photoUrls = [];
  if (platform === 'zinspector') {
    photoUrls = await extractZinspectorPhotoUrls(page);
  } else {
    // Generic: grab all visible img elements
    photoUrls = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll('img').forEach(img => {
        if (img.naturalWidth < 100 || img.naturalHeight < 100) return;
        if (!img.src || img.src.startsWith('data:')) return;
        if (img.src.includes('logo') || img.src.includes('icon') || img.src.includes('avatar')) return;
        urls.push(img.src);
      });
      return urls;
    });
  }
  console.log(`[extract] Found ${photoUrls.length} photo URLs`);

  // 4. Download photos as base64 (max 25)
  const photos = [];
  for (const url of photoUrls.slice(0, 25)) {
    try {
      const dataUrl = await downloadPhotoAsBase64(page, url);
      if (dataUrl && dataUrl.includes(',')) {
        let base64 = dataUrl.split(',')[1];
        let mediaType = dataUrl.split(';')[0].split(':')[1] || 'image/jpeg';
        // Resize if needed (Claude max 8000px per dimension, we use 7000 for safety)
        const resized = await resizeImageIfNeeded(page, base64, mediaType, 7000);
        base64 = resized.base64;
        mediaType = resized.mediaType;
        photos.push({ base64, mediaType, sourceUrl: url });
        console.log(`[extract] Downloaded photo ${photos.length}: ${url.substring(0, 80)}`);
      }
    } catch (e) {
      console.warn(`[extract] Failed to download: ${url.substring(0, 80)}`, e.message);
    }
  }
  console.log(`[extract] Downloaded ${photos.length} photos as base64`);

  // 5. Extract visible text content — grab more for Zinspector to capture the full summary
  const textLimit = platform === 'zinspector' ? 100000 : 15000;
  const textContent = await page.evaluate((limit) => {
    return document.body.innerText.substring(0, limit);
  }, textLimit);

  // 6. Property info from page title/headings
  const property = await page.evaluate(() => {
    const title = document.title || '';
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    return {
      address: h1 || title.split('-')[0]?.trim() || title.split('|')[0]?.trim() || null,
      unit: null,
      tenant: null,
      inspectionDate: null,
      inspectionType: null,
    };
  });

  return {
    platform,
    url: page.url(),
    screenshots,
    photos,
    tableData, // Zinspector condition summary rows (structured)
    property,
    textContent,
    extractedAt: new Date().toISOString()
  };
}

/**
 * Build messages for Claude comparison — sends actual images via vision API
 */
function buildComparisonMessages(newInspection, previousInspections, context) {
  const content = [];

  const isComparison = previousInspections.length > 0;

  // System context — pure issue-finding prompt (no liability decisions)
  const propertyInfo = `Property: ${context.address || newInspection.property?.address || 'Property'}
Unit: ${context.unit || newInspection.property?.unit || ''}
Tenant: ${context.tenant || newInspection.property?.tenant || 'Tenant'}
Lease Duration: ${context.leaseDuration || 'Not specified'}`;

  const hasTableData = newInspection.tableData?.length > 0;
  const tableInstruction = hasTableData
    ? `\n\nA structured table has also been extracted as text. Cross-reference it with the screenshots to ensure you don't miss any items.`
    : '';

  content.push({
    type: 'text',
    text: isComparison
      ? `You are a property inspection analyst. Your job is to FIND and LIST every issue — a human reviewer will decide liability.

${propertyInfo}

TASK: Compare the MOVE-OUT inspection against the MOVE-IN inspection. For every issue you find:
1. Describe exactly what you see
2. Note the room and specific area
3. Reference the table row number or photo where you see it
4. State whether this issue was ALSO visible in the move-in inspection
${tableInstruction}

IMPORTANT:
- List EVERY issue you can find, even minor ones — the reviewer will skip what doesn't matter
- Do NOT decide who is responsible — that is the reviewer's job
- Do NOT estimate costs — that is the reviewer's job
- DO note if an issue appears in the move-in photos/data (so the reviewer has context)
- Be specific about location: "left wall near window" not just "wall"
- The screenshots show the FULL condition summary — go through EVERY screenshot page
- For each row in the summary with condition "P" (Poor) or any comment describing damage/issues, create an issue
- Look for page numbers in the screenshots (e.g., "Page 3 of 149") and use the ACTUAL PAGE NUMBER as the section reference (e.g., "Page 3")
- If no page number is visible, use the room name as the reference (e.g., "Kitchen section")
- Cross-reference the extracted text data if provided
- Inspections may have 50-100+ issues spanning 20+ pages. Do NOT stop early or truncate. Find ALL issues across ALL rooms including bedrooms, bathrooms, systems, garage, and exterior.
- BOTH inspections (move-out AND move-in) have full data. Check every item in the current inspection against the previous inspection.`

      : `You are a property inspection analyst. Your job is to FIND and LIST every issue — a human reviewer will decide liability.

${propertyInfo}

TASK: Review this inspection and catalog every issue or condition you can find.
${tableInstruction}

IMPORTANT:
- List EVERY issue you can find, even minor ones — the reviewer will skip what doesn't matter
- Do NOT decide who is responsible — that is the reviewer's job
- Do NOT estimate costs — that is the reviewer's job
- Be specific about location: "left wall near window" not just "wall"
- Go through EVERY screenshot page — the condition summary spans multiple pages
- For each row with condition "P" (Poor) or any comment describing damage/issues, create an issue
- Look for page numbers in the screenshots (e.g., "Page 3 of 149") and use the ACTUAL PAGE NUMBER as the section reference (e.g., "Page 3")
- If no page number is visible, use the room name as the reference (e.g., "Kitchen section")
- Cross-reference the extracted text data if provided
- Inspections may have 50-100+ issues spanning 20+ pages. Do NOT stop early or truncate. Find ALL issues across ALL rooms including bedrooms, bathrooms, systems, garage, and exterior.`
  });

  // Helper to add inspection data to content
  function addInspectionContent(inspection, label) {
    content.push({ type: 'text', text: `\n\n## ${label}\n` });

    // PRIMARY: Send ALL viewport screenshots (up to 15 for Zinspector)
    if (inspection.screenshots?.length > 0) {
      content.push({ type: 'text', text: `Report screenshots (${inspection.screenshots.length} pages — review EVERY page for issues):` });
      for (const shot of inspection.screenshots) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: shot }
        });
      }
    }

    // SUPPLEMENTARY: Individual inspection photos (max 10)
    if (inspection.photos?.length > 0) {
      content.push({ type: 'text', text: `\nInspection photos (${inspection.photos.length}):` });
      for (const photo of inspection.photos.slice(0, 10)) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: photo.mediaType || 'image/jpeg', data: photo.base64 }
        });
      }
    }

    // SUPPLEMENTARY: Raw text content — helps catch items vision might miss
    if (inspection.textContent) {
      content.push({ type: 'text', text: `\nExtracted page text (cross-reference with screenshots):\n${inspection.textContent}` });
    }

    // SUPPLEMENTARY: Structured table data if extracted
    if (inspection.tableData?.length > 0) {
      let tableText = `\nStructured table data (${inspection.tableData.length} rows — cross-reference with screenshots):\n`;
      tableText += 'Row# | Room | Detail | Condition | Actions | Comment\n';
      inspection.tableData.forEach((row, i) => {
        tableText += `${i + 1} | ${row.room} | ${row.detail} | ${row.condition} | ${row.actions} | ${row.comment}\n`;
      });
      content.push({ type: 'text', text: tableText });
    }
  }

  // Move-out inspection
  addInspectionContent(newInspection, 'MOVE-OUT INSPECTION (Current Condition)');

  // Move-in inspection(s)
  const moveIn = previousInspections[0];
  if (moveIn) {
    addInspectionContent(moveIn, 'MOVE-IN INSPECTION (Baseline)');
  } else {
    content.push({ type: 'text', text: '\n\n## NO MOVE-IN INSPECTION PROVIDED\nAnalyze only the current condition.\n' });
  }

  // Mission 8: utility status extraction directive — same wording as V3, kept
  // in lockstep so V2 + V3 banners surface the same property-level signal.
  const utilityStatusInstructions = `
ALSO extract property-level utility status from the inspection PDF's COVER PAGE
or property-metadata section. Output as a top-level "utilityStatus" object with
the shape shown in the schema below.

Use 'on' when the cover page indicates the utility is active (check marks, "water
on", no "no service" notes, fixtures throughout the inspection appear functional).
Use 'off' when the cover page or multiple fixtures throughout consistently indicate
the utility is unavailable (e.g., "no water service to property", 6+ fixtures all
reporting "no water"). Use 'unknown' when the cover page is silent AND the
inspection findings don't provide a clear systemic signal — when in doubt,
'unknown' is safer than a false 'off'.

Do NOT use individual defect mentions to infer property-level utility status.
"Leaking water heater", "kitchen faucet drips", "rusty water heater", "outlet
near breaker" are LOCALIZED fixture issues, not utility-service status. The
signal you're looking for is property-wide, not fixture-level. A property with
50+ defect-level water mentions can still have water service ON.
`;

  content.push({
    type: 'text',
    text: isComparison
      ? `\n\nReturn your findings as JSON. List ALL issues — do not skip minor ones:
${utilityStatusInstructions}
{
  "overall_condition": "excellent|good|fair|poor",
  "summary": "2-3 sentence overview of what you found",
  "utilityStatus": {
    "water": "on",
    "power": "on",
    "gas": "unknown"
  },
  "issues": [
    {
      "room": "Kitchen",
      "area": "Countertop near sink",
      "description": "What you observe in the move-out photos",
      "severity": "minor|moderate|major",
      "section": "Page 4",
      "photo_reference": "Photo #4 or description of which photo",
      "in_move_in": "yes|no|unclear",
      "move_in_note": "What the move-in photo showed for this area, if visible"
    }
  ]
}`
      : `\n\nReturn your findings as JSON. List ALL issues — do not skip minor ones:
${utilityStatusInstructions}
{
  "overall_condition": "excellent|good|fair|poor",
  "summary": "2-3 sentence overview of what you found",
  "utilityStatus": {
    "water": "on",
    "power": "on",
    "gas": "unknown"
  },
  "issues": [
    {
      "room": "Kitchen",
      "area": "Countertop near sink",
      "description": "What you observe",
      "severity": "minor|moderate|major",
      "section": "Page 4",
      "photo_reference": "Photo #4 or description of which photo"
    }
  ]
}`
  });

  return [{ role: 'user', content }];
}

// ============================================================================
// V3 prompt builders (Mission 3 Phase 2 — categorized buckets)
// ============================================================================

/**
 * Shared bucket definitions + emission rules used by both V3 prompt builders.
 * Kept as one constant so the comparison and single-inspection prompts stay
 * in sync — drift between them would produce inconsistent AI output.
 */
const V3_BUCKET_AND_FORMAT_INSTRUCTIONS = `
## Categorization buckets

Every issue you find must be assigned to exactly one bucket. Pick the bucket
that best describes the *remediation work*, not just the symptom.

- **cleaning** — cosmetic issues resolved by cleaning alone. No materials are
  replaced. Examples: dust, dirt, smudges, fingerprints, light stains, cobwebs,
  soap scum, mildew (surface), pet hair, food residue.

- **make_ready** — repair, patching, replacement, painting; materials and labor
  beyond cleaning. Examples: holes in drywall, cracks, broken fixtures, missing
  hardware, scratches in flooring, paint touch-ups, mold (deep), leaks, torn
  carpet, warped trim, faulty outlets.

- **exterior** — anything outside the building envelope. Examples: yard, fence,
  gate, driveway, sidewalk, siding, roof, gutters, downspouts, exterior light
  fixtures, A/C condenser unit, mailbox, soffits, brick veneer, sprinkler.

When borderline, prefer the bucket the property manager would assign work to.
A grease-stained range hood that wipes off → cleaning. A range hood that needs
repainting → make_ready.

## Confidence scoring (bucketConfidence)

Emit a number from 0.0 to 1.0 for every issue:
- 0.9–1.0: bucket is unambiguous (a hole in drywall is clearly make_ready).
- 0.6–0.8: bucket is reasonable but could be argued (heavy stain that might
  clean off vs. need re-finishing).
- < 0.6: genuinely ambiguous — the system will fall back to keyword matching.

Be honest. A confident wrong bucket is worse than a low-confidence bucket the
fallback can correct.

## Grouping (groupKey + groupLabel)

When the SAME type of issue appears in multiple rooms, emit the same
\`groupKey\` (kebab-case slug) and \`groupLabel\` (human-readable) on each
issue. The system collapses identical groupKeys into one group so the reviewer
sees them together.

Examples:
- "Baseboards — dusty" in 5 rooms → groupKey: "baseboards-dusty",
  groupLabel: "Baseboards — Dusty"
- "Outlet cover missing" in 3 rooms → groupKey: "outlet-cover-missing",
  groupLabel: "Outlet Cover — Missing"

Distinct issues get distinct groupKeys. Don't over-group: a stained countertop
and a stained cabinet are different.

## Severity enum (strict)

Use exactly one of: \`minor\`, \`moderate\`, \`major\`. Do not invent values.

## Page references

When the screenshots show a page number (e.g., "Page 3 of 149"), include the
integer in \`pageReferences\` (e.g., \`[3]\`). If multiple pages document the
same issue, include all (\`[3, 4]\`). If no page number is visible, emit \`[]\`.

## Property utility status (extract from cover page, NOT from defect descriptions)

ALSO extract property-level utility status from the inspection PDF's COVER PAGE
or property-metadata section. Output as a top-level \`utilityStatus\` object:

  "utilityStatus": {
    "water": "on" | "off" | "unknown",
    "power": "on" | "off" | "unknown",
    "gas": "on" | "off" | "unknown"
  }

Use 'on' when the cover page indicates the utility is active (check marks next
to the utility name, "water on", absence of any "no service" notes, AND
fixtures throughout the inspection report appear functional).

Use 'off' when the cover page or multiple fixtures throughout the inspection
report consistently indicate the utility is unavailable (e.g., "no water
service to property", 6+ fixtures all reporting "no water", similar systemic
patterns for power/gas).

Use 'unknown' when the cover page does not indicate utility status AND the
inspection findings don't provide a clear systemic signal either way. When in
doubt, use 'unknown' — false 'off' calls are worse than missing data.

Do NOT use individual defect mentions to infer property-level utility status.
"Leaking water heater", "kitchen faucet drips", "rusty water heater", "outlet
near breaker" are all LOCALIZED fixture issues, not utility-service status.
A property with 50+ defect-level water mentions can still have water service
ON. The signal you're looking for is property-wide, not fixture-level.

## Output schema (strict — return ONLY this JSON, no prose, no code fences)

{
  "overall_condition": "excellent|good|fair|poor",
  "summary": "2-3 sentence overview of what you found",
  "utilityStatus": {
    "water": "on",
    "power": "on",
    "gas": "unknown"
  },
  "issues": [
    {
      "room": "Kitchen",
      "area": "Countertop near sink",
      "description": "Dark ring stain approximately 4 inches across, appears to be from a hot pot",
      "severity": "moderate",
      "pageReferences": [4],
      "isNewSinceMoveIn": true,
      "moveInNote": "Optional context if relevant — omit if not",
      "bucket": "cleaning",
      "bucketConfidence": 0.7,
      "groupKey": "countertops-stained",
      "groupLabel": "Countertops — Stained"
    }
  ]
}
`;

/**
 * Build V3 comparison-mode messages (move-out vs move-in).
 * Same content layout as buildComparisonMessages but asks for the V3 schema.
 */
function buildV3ComparisonMessages(newInspection, previousInspections, context) {
  const content = [];

  const propertyInfo = `Property: ${context.address || newInspection.property?.address || 'Property'}
Unit: ${context.unit || newInspection.property?.unit || ''}
Tenant: ${context.tenant || newInspection.property?.tenant || 'Tenant'}
Lease Duration: ${context.leaseDuration || 'Not specified'}`;

  const hasTableData = newInspection.tableData?.length > 0;
  const tableInstruction = hasTableData
    ? `\n\nA structured table has also been extracted as text. Cross-reference it with the screenshots to ensure you don't miss any items.`
    : '';

  content.push({
    type: 'text',
    text: `You are a property inspection analyst. Your job is to FIND every issue and CATEGORIZE each one — a human reviewer will decide liability.

${propertyInfo}

TASK: Compare the MOVE-OUT inspection against the MOVE-IN inspection. For every issue you find:
1. Describe exactly what you see
2. Note the room and specific area
3. Categorize into one of three buckets (see below)
4. Score how confident you are about the bucket
5. Reference the page number when visible
6. Set isNewSinceMoveIn = true when the move-in inspection did NOT show this issue,
   false when it did (i.e., pre-existing)
${tableInstruction}

IMPORTANT:
- List EVERY issue you can find, even minor ones — the reviewer will skip what doesn't matter
- Do NOT decide who is responsible — the reviewer assigns Tenant/Owner/Normal Wear
- Do NOT estimate costs — that is the reviewer's job
- DO note if an issue appears in the move-in photos/data
- Be specific about location: "left wall near window" not just "wall"
- Go through EVERY screenshot page — the condition summary spans multiple pages
- Cross-reference the extracted text data if provided
- Inspections may have 50-100+ issues spanning 20+ pages. Do NOT stop early. Find ALL issues across ALL rooms including bedrooms, bathrooms, systems, garage, and exterior.
- BOTH inspections (move-out AND move-in) have full data. Check every item.

${V3_BUCKET_AND_FORMAT_INSTRUCTIONS}`,
  });

  appendInspectionContent(content, newInspection, 'MOVE-OUT INSPECTION (Current Condition)');

  const moveIn = previousInspections[0];
  if (moveIn) {
    appendInspectionContent(content, moveIn, 'MOVE-IN INSPECTION (Baseline)');
  } else {
    content.push({ type: 'text', text: '\n\n## NO MOVE-IN INSPECTION PROVIDED\nAnalyze only the current condition.\n' });
  }

  content.push({
    type: 'text',
    text: '\n\nReturn the JSON object now. No markdown code fences. No explanation. Begin with { and end with }.',
  });

  return [{ role: 'user', content }];
}

/**
 * Build V3 single-inspection-mode messages (no comparison baseline).
 * AI sets isNewSinceMoveIn=true uniformly; orchestrator overrides liability
 * to 'unassigned' for all issues per Q14.
 */
function buildV3SingleInspectionMessages(currentInspection, context) {
  const content = [];

  const propertyInfo = `Property: ${context.address || currentInspection.property?.address || 'Property'}
Unit: ${context.unit || currentInspection.property?.unit || ''}
Tenant: ${context.tenant || currentInspection.property?.tenant || 'Tenant'}
Lease Duration: ${context.leaseDuration || 'Not specified'}`;

  const hasTableData = currentInspection.tableData?.length > 0;
  const tableInstruction = hasTableData
    ? `\n\nA structured table has also been extracted as text. Cross-reference it with the screenshots to ensure you don't miss any items.`
    : '';

  content.push({
    type: 'text',
    text: `You are a property inspection analyst. Your job is to FIND every issue and CATEGORIZE each one — a human reviewer will decide liability.

${propertyInfo}

TASK: Review this inspection and catalog every issue. For each issue:
1. Describe exactly what you see
2. Note the room and specific area
3. Categorize into one of three buckets (see below)
4. Score your confidence about the bucket
5. Reference the page number when visible
6. Set isNewSinceMoveIn = true (no move-in baseline provided; the reviewer will assign liability)
${tableInstruction}

IMPORTANT:
- List EVERY issue you can find, even minor ones — the reviewer will skip what doesn't matter
- Do NOT decide who is responsible — the reviewer assigns Tenant/Owner/Normal Wear
- Do NOT estimate costs — that is the reviewer's job
- Be specific about location: "left wall near window" not just "wall"
- Go through EVERY screenshot page — the condition summary spans multiple pages
- Cross-reference the extracted text data if provided
- Inspections may have 50-100+ issues spanning 20+ pages. Do NOT stop early. Find ALL issues across ALL rooms including bedrooms, bathrooms, systems, garage, and exterior.

${V3_BUCKET_AND_FORMAT_INSTRUCTIONS}`,
  });

  appendInspectionContent(content, currentInspection, 'INSPECTION (Current Condition)');

  content.push({
    type: 'text',
    text: '\n\nReturn the JSON object now. No markdown code fences. No explanation. Begin with { and end with }.',
  });

  return [{ role: 'user', content }];
}

/**
 * Shared inspection-content appender used by V3 prompt builders. Mirrors the
 * inner helper inside buildComparisonMessages so V3 sees the same screenshots,
 * photos, text, and table data the V2 prompt sees.
 */
function appendInspectionContent(content, inspection, label) {
  content.push({ type: 'text', text: `\n\n## ${label}\n` });

  if (inspection.screenshots?.length > 0) {
    content.push({ type: 'text', text: `Report screenshots (${inspection.screenshots.length} pages — review EVERY page for issues):` });
    for (const shot of inspection.screenshots) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: shot },
      });
    }
  }

  if (inspection.photos?.length > 0) {
    content.push({ type: 'text', text: `\nInspection photos (${inspection.photos.length}):` });
    for (const photo of inspection.photos.slice(0, 10)) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: photo.mediaType || 'image/jpeg', data: photo.base64 },
      });
    }
  }

  if (inspection.textContent) {
    content.push({ type: 'text', text: `\nExtracted page text (cross-reference with screenshots):\n${inspection.textContent}` });
  }

  if (inspection.tableData?.length > 0) {
    let tableText = `\nStructured table data (${inspection.tableData.length} rows — cross-reference with screenshots):\n`;
    tableText += 'Row# | Room | Detail | Condition | Actions | Comment\n';
    inspection.tableData.forEach((row, i) => {
      tableText += `${i + 1} | ${row.room} | ${row.detail} | ${row.condition} | ${row.actions} | ${row.comment}\n`;
    });
    content.push({ type: 'text', text: tableText });
  }
}

/**
 * Parse AI analysis response — handles markdown code fences and malformed JSON
 */
function parseAnalysisResponse(text) {
  // Step 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = text;
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Step 2: Extract from first { to last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('Failed to parse JSON after cleanup:', e.message);
      console.error('Raw response (first 2000 chars):', text.substring(0, 2000));
    }
  }

  // Step 3: Fallback — return structured error so the UI can still render
  console.error('Could not extract JSON from AI response. Full response logged above.');
  console.error('Raw response (first 2000 chars):', text.substring(0, 2000));
  return {
    overall_condition: 'unknown',
    summary: 'AI returned a response but it could not be parsed as JSON. Try again or switch AI backends.',
    issues: [],
  };
}
