/**
 * Preload Script
 * 
 * This creates a secure bridge between the UI (index.html) and the 
 * backend (main.js). The UI can't access Node.js directly for security,
 * so this exposes only the specific functions we need.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Initialize browser connection
  initBrowser: () => ipcRenderer.invoke('init-browser'),

  // Open login pages for platforms
  openLoginPages: (urls) => ipcRenderer.invoke('open-login-pages', urls),

  // Check login status
  checkLoginStatus: (urls) => ipcRenderer.invoke('check-login-status', urls),

  // Fetch a single inspection from URL
  fetchInspection: (url) => ipcRenderer.invoke('fetch-inspection', url),

  // Run AI analysis on inspections
  analyzeInspections: (data) => ipcRenderer.invoke('analyze-inspections', data),

  // Parse a PDF file and extract inspection data
  parsePdf: (filePath) => ipcRenderer.invoke('parse-pdf', filePath),

  // Send inspection data + results to KeepSimpleCRM
  sendToCrm: (data) => ipcRenderer.invoke('send-to-crm', data),

  // Send V4 review (Mission 9 Phase B.2 / Mission 7.2 Phase C). V4 has its
  // own decision map shape (bucketDecisions / itemDecisions / itemSkipped)
  // and goes to /api/inspections/v4/save instead of /api/inspections/ai-review.
  sendV4ToCrm: (data) => ipcRenderer.invoke('send-v4-to-crm', data),

  // Listen for progress updates
  onProgress: (callback) => {
    ipcRenderer.on('progress', (event, data) => callback(data));
  },

  // ----- Auth (Mission 7.2 Phase B) -----

  // Submit login. Returns {success, user, organization} on 200, or
  // {success:false, status, error, lockedUntil?, remainingAttempts?} on
  // failure. Status 0 means network failure.
  electronLogin: (creds) => ipcRenderer.invoke('electron-login', creds),

  // Logout: revokes the stored key on the server (best-effort) and clears
  // local credentials.bin. Idempotent.
  electronLogout: () => ipcRenderer.invoke('electron-logout'),

  // Returns either {authenticated:true, user, organization, serverWwwUrl}
  // or {authenticated:false, lastEmail}. plaintextKey is never exposed.
  getAuthState: () => ipcRenderer.invoke('auth-state'),

  // Subscribe to auth-expired events emitted by the main process when
  // send-to-crm gets a 401 or credentials vanish mid-session.
  onAuthExpired: (callback) => {
    ipcRenderer.on('auth-expired', () => callback());
  },

  // Open a whitelisted external URL in the system browser. Currently only
  // https://www.keepsimplecrm.com/* is allowed. Used for the forgot-
  // password link.
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // v1.2.3 Fix 3 — trigger an audible + visual alert from the main process
  // when a save fails. Plays the system beep and flashes the taskbar frame
  // on Windows. Best-effort; the renderer's showSaveError() catches any
  // throw and surfaces the modal regardless.
  saveErrorAlert: () => ipcRenderer.invoke('save-error-alert'),

  // ----- Mission 10 Workstream B — inspection-review:// deep-link handoff -----

  // Subscribe to inspection-import deep links. Callback receives
  // { platform: 'appfolio'|'zinspector', urls: string[] }. The renderer
  // should call deepLinkRendererReady() once it has installed this
  // listener so the main process can flush any link buffered during
  // cold-start.
  onInspectionImportDeepLink: (callback) => {
    ipcRenderer.on('inspection-import-deep-link', (_event, payload) => callback(payload));
  },

  // Tell main process the renderer is ready to receive deep-link events.
  deepLinkRendererReady: () => ipcRenderer.send('deep-link-renderer-ready'),
});
