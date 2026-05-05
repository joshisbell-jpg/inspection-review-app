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

  // Listen for progress updates
  onProgress: (callback) => {
    ipcRenderer.on('progress', (event, data) => callback(data));
  }
});
