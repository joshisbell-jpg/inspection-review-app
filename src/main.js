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
const { app, BrowserWindow, ipcMain } = require('electron');

// In packaged app, resources are in process.resourcesPath
// In dev, they're in the project root
const isPackaged = app.isPackaged;
const resourcesPath = isPackaged ? process.resourcesPath : __dirname.replace(/[/\\]src$/, '');

// ============================================
// AI Backend Config (persisted to userData)
// ============================================
const AI_CONFIG_FILE = path.join(app.getPath('userData'), 'ai-config.json');

function loadAiConfig() {
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load AI config, using defaults:', e.message);
  }
  return { backend: 'claude' };
}

function saveAiConfig(config) {
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

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
 * Convert Anthropic-format messages to Ollama chat format.
 * Anthropic: [{ role, content: [{ type: 'text', text }, { type: 'image', source: { data } }] }]
 * Ollama:    [{ role, content: 'string', images: ['base64'] }]
 */
function convertToOllamaMessages(anthropicMessages) {
  return anthropicMessages.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    const textParts = [];
    const images = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image' && block.source?.data) {
        images.push(block.source.data);
      }
    }
    const result = { role: msg.role, content: textParts.join('\n') };
    if (images.length > 0) {
      result.images = images;
    }
    return result;
  });
}

/**
 * Call Ollama (Gemma 4) for AI analysis.
 */
async function callOllama(anthropicMessages) {
  const ollamaMessages = convertToOllamaMessages(anthropicMessages);

  // Debug: log what we're sending to Ollama
  console.log(`[ollama] === OUTBOUND PAYLOAD ===`);
  console.log(`[ollama] Total messages: ${ollamaMessages.length}`);
  let totalPayloadBytes = 0;
  for (let i = 0; i < ollamaMessages.length; i++) {
    const msg = ollamaMessages[i];
    const contentPreview = (msg.content || '').substring(0, 500);
    const contentBytes = Buffer.byteLength(msg.content || '', 'utf-8');
    const imageCount = msg.images?.length || 0;
    const imageBytes = (msg.images || []).reduce((sum, img) => sum + img.length, 0);
    totalPayloadBytes += contentBytes + imageBytes;

    console.log(`[ollama] Message ${i}: role=${msg.role}, content=${contentBytes} bytes, images=${imageCount}`);
    console.log(`[ollama]   Content preview: ${contentPreview}${(msg.content || '').length > 500 ? '...' : ''}`);
    if (imageCount > 0) {
      msg.images.forEach((img, j) => {
        console.log(`[ollama]   [BASE64 IMAGE ${j} - ${img.length} bytes]`);
      });
    }
  }
  console.log(`[ollama] Total approximate payload size: ${(totalPayloadBytes / 1024).toFixed(1)} KB`);
  console.log(`[ollama] === END PAYLOAD ===`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 min timeout
  try {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma4:e4b',
        messages: ollamaMessages,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Ollama error (HTTP ${response.status}): ${errText}`);
    }
    const data = await response.json();
    const content = data?.message?.content;
    if (!content) {
      throw new Error(`Ollama returned unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Claude (Anthropic SDK) for AI analysis.
 */
async function callClaude(anthropicMessages) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16384,
    messages: anthropicMessages,
  });
  return response.content[0].text;
}

/**
 * Wrap messages with strict JSON formatting instructions for Ollama/Gemma.
 * Prepends and appends enforcement text to the user message content array.
 */
/**
 * Strip boilerplate from inspection text — remove repeated headers, page numbers,
 * image references, and other noise that inflates the payload without adding value.
 */
function cleanInspectionText(text) {
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      // Drop empty lines
      if (!trimmed) return false;
      // Drop page number lines like "Page 3 of 149", "- 3 -", etc.
      if (/^(Page\s+\d+\s+(of|\/)\s+\d+|[-–—]\s*\d+\s*[-–—])$/i.test(trimmed)) return false;
      // Drop image/photo reference lines
      if (/^(Image|Photo|Photograph|Attachment|IMG_)\s*[:#\d]/i.test(trimmed)) return false;
      // Drop repeated headers (common in multi-page PDFs)
      if (/^(Condition Summary|Inspection Report|Property Inspection|Move.?Out|Move.?In)\s*$/i.test(trimmed)) return false;
      // Drop pure URL lines
      if (/^https?:\/\/\S+$/.test(trimmed)) return false;
      // Drop date-only lines
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(trimmed)) return false;
      return true;
    })
    .join('\n');
}

/**
 * Reduce payload size for Ollama — strip images, trim text content.
 * Current inspection: max 20,000 chars. Previous inspection: max 10,000 chars.
 */
function trimMessagesForOllama(messages) {
  let isCurrent = true; // first inspection block is current, second is previous

  return messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;

    const trimmedContent = [];
    for (const block of msg.content) {
      // Drop all image blocks — Gemma processes text from PDFs more reliably
      if (block.type === 'image') continue;

      if (block.type === 'text') {
        let text = block.text;

        // Detect inspection content blocks and trim them
        if (text.includes('Extracted page text') || text.includes('cross-reference with screenshots')) {
          text = cleanInspectionText(text);
          const limit = isCurrent ? 20000 : 10000;
          if (text.length > limit) {
            text = text.substring(0, limit) + '\n[... text trimmed to ' + limit + ' chars for processing ...]';
          }
          // After first inspection text block, switch to previous limit
          isCurrent = false;
        }

        // Drop screenshot reference lines from other text blocks
        if (text.includes('Report screenshots') && text.includes('review EVERY page')) {
          continue; // skip the "Report screenshots (N pages)" label since we dropped images
        }
        if (text.includes('Inspection photos') && text.includes(':')) {
          continue; // skip the "Inspection photos (N):" label since we dropped images
        }

        trimmedContent.push({ type: 'text', text });
      }
    }

    return { ...msg, content: trimmedContent };
  });
}

function addOllamaJsonEnforcement(messages) {
  const schemaExample = `Return ONLY this exact JSON structure, no other format:
{
  "issues": [
    {
      "title": "short issue title",
      "location": "room or area",
      "severity": "low|medium|high",
      "description": "detailed description",
      "isPreExisting": true or false
    }
  ],
  "overall": "overall assessment text"
}`;

  return messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: [
        {
          type: 'text',
          text: 'You must respond with ONLY a JSON object. No explanation, no markdown, no code blocks. Start your response with { and end with }.\n\n' + schemaExample
        },
        ...msg.content,
        {
          type: 'text',
          text: 'RESPOND WITH JSON ONLY using the exact schema specified above (issues array with title/location/severity/description/isPreExisting, and overall string). Begin your response with the opening brace {'
        }
      ]
    };
  });
}

/**
 * Normalize Ollama/Gemma response to the expected app format.
 * Handles Gemma's alternate structure: { overall_assessment, detailed_issues_by_area: [{ area, issues: [string] }] }
 */
function normalizeOllamaResponse(parsed) {
  // Already in expected format
  if (Array.isArray(parsed.issues) && parsed.issues.length > 0 && parsed.issues[0].title) {
    return parsed;
  }

  // Gemma alternate format: detailed_issues_by_area
  if (Array.isArray(parsed.detailed_issues_by_area)) {
    const issues = [];
    for (const area of parsed.detailed_issues_by_area) {
      const areaName = area.area || 'Unknown';
      const areaIssues = Array.isArray(area.issues) ? area.issues : [];
      for (const issue of areaIssues) {
        const issueText = typeof issue === 'string' ? issue : (issue.description || issue.title || JSON.stringify(issue));
        issues.push({
          title: issueText,
          location: areaName,
          severity: (typeof issue === 'object' && issue.severity) || 'unknown',
          description: issueText,
          isPreExisting: (typeof issue === 'object' && issue.isPreExisting) || false,
        });
      }
    }
    return {
      issues,
      overall: parsed.overall_assessment || parsed.overall || '',
    };
  }

  // Unknown format — return as-is so parseAnalysisResponse fallback handles it
  return parsed;
}

/**
 * Process inspections with switchable AI backend
 */
ipcMain.handle('analyze-inspections', async (event, { newInspection, previousInspections, context }) => {
  try {
    const config = loadAiConfig();
    const messages = buildComparisonMessages(newInspection, previousInspections, context);

    let responseText;
    const isOllama = config.backend !== 'claude';
    if (!isOllama) {
      responseText = await callClaude(messages);
    } else {
      const trimmed = trimMessagesForOllama(messages);
      const enforced = addOllamaJsonEnforcement(trimmed);
      responseText = await callOllama(enforced);
      console.log('[ollama] Raw Gemma response (first 3000 chars):', responseText.substring(0, 3000));
      console.log('[ollama] Raw Gemma response (last 500 chars):', responseText.substring(Math.max(0, responseText.length - 500)));
    }

    let result = parseAnalysisResponse(responseText);
    if (isOllama) {
      result = normalizeOllamaResponse(result);
    }
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// AI config IPC handlers
ipcMain.handle('get-ai-config', () => loadAiConfig());

ipcMain.handle('set-ai-config', (event, config) => {
  const validBackends = ['gemma', 'claude'];
  if (!validBackends.includes(config.backend)) {
    return { success: false, error: `Invalid backend: ${config.backend}` };
  }
  try {
    saveAiConfig({ backend: config.backend });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-ollama-health', async () => {
  try {
    const response = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { available: false, hasModel: false };
    const data = await response.json();
    const modelNames = (data.models || []).map(m => m.name);
    const hasModel = modelNames.some(n => n.includes('gemma4:e4b'));
    return { available: true, hasModel };
  } catch {
    return { available: false, hasModel: false };
  }
});

/**
 * Send inspection data + results to KeepSimpleCRM
 */
ipcMain.handle('send-to-crm', async (event, { currentInspection, previousInspections, context, result, reviewerDecisions }) => {
  try {
    const crmUrl = process.env.CRM_API_URL || 'https://keepsimplecrm.com';
    const crmToken = process.env.CRM_API_TOKEN;

    if (!crmToken) {
      return { success: false, error: 'CRM_API_TOKEN not set in .env' };
    }

    const response = await fetch(`${crmUrl}/api/inspections/ai-review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${crmToken}`,
      },
      body: JSON.stringify({
        address: context.address || currentInspection.property?.address,
        unit: context.unit || currentInspection.property?.unit,
        tenantName: context.tenant || currentInspection.property?.tenant,
        securityDeposit: context.deposit ? Number(context.deposit) : undefined,
        leaseDuration: context.leaseDuration,
        currentInspectionUrl: currentInspection.url,
        previousInspectionUrls: previousInspections.map(p => p.url),
        currentInspectionData: currentInspection,
        previousInspectionsData: previousInspections,
        analysisResult: result,
        reviewerDecisions: reviewerDecisions,
      }),
    });

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

    // Detect platform from PDF content
    let platform = 'unknown';
    if (text.toLowerCase().includes('zinspector') || text.toLowerCase().includes('condition summary')) {
      platform = 'zinspector';
    } else if (text.toLowerCase().includes('appfolio')) {
      platform = 'appfolio';
    }

    const address = extractPropertyAddress(text, platform);

    return {
      success: true,
      data: {
        platform,
        url: filePath,
        screenshots: [],     // No screenshots for PDF
        photos: [],           // No photos for PDF
        tableData: [],        // No DOM table data for PDF
        property: { address },
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
 * Returns the property address string. Falls back to legacy naive regex if
 * format-specific extraction fails — Mission 2.5c will add a human-editable
 * field in the renderer as the final safety net.
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
        return result;
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
            return result;
          }
        }
      }
    }
  }

  // Fallback: legacy naive regex (better wrong than empty)
  for (const line of lines.slice(0, 20)) {
    if (/^\d+\s+\w/.test(line) && line.length < 100) {
      console.warn(`[parse-pdf] address via legacy fallback regex (may be wrong) → ${line}`);
      return line;
    }
  }

  console.warn('[parse-pdf] no address extracted');
  return '';
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

  content.push({
    type: 'text',
    text: isComparison
      ? `\n\nReturn your findings as JSON. List ALL issues — do not skip minor ones:
{
  "overall_condition": "excellent|good|fair|poor",
  "summary": "2-3 sentence overview of what you found",
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
{
  "overall_condition": "excellent|good|fair|poor",
  "summary": "2-3 sentence overview of what you found",
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
