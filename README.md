# Inspection Review

Desktop app for KeepSimpleCRM property managers to review property
inspections — uploads move-out PDFs (with optional move-in PDF for
comparison) from AppFolio or zInspector, runs AI-assisted issue
detection through the KeepSimpleCRM server, lets the reviewer assign
liability per issue, and saves the finalized review back to the CRM.

> **This is internal tooling for Isbell Rentals.** Source is public
> for transparency and to enable installer downloads. No reuse rights
> are granted (no LICENSE file by design — default copyright applies).

---

## For inspectors

Don't clone this repo. Visit
[keepsimplecrm.com/ai-review/electron](https://www.keepsimplecrm.com/ai-review/electron)
for the installer download and setup instructions.

## For developers

### Stack

- Electron 29 (desktop shell, main + renderer processes)
- pdf-parse (PDF text extraction — current AI-input path)
- Playwright (legacy AppFolio/zInspector scraping path; bundled
  Chromium kept for the older URL-based flow)
- Native `fetch` against KeepSimpleCRM at `https://www.keepsimplecrm.com`
  for all authenticated calls (login, AI analysis proxy, save-to-CRM).
  No Anthropic SDK on the client; no API keys shipped with the
  installer.

### Local dev

```bash
git clone https://github.com/joshisbell-jpg/inspection-review-app.git
cd inspection-review-app
npm install
npm start
```

The app launches against `https://www.keepsimplecrm.com` by default.
Optional environment variables (set in `.env` next to `package.json`):

- `CRM_LOGIN_URL` — override the login endpoint (e.g. for local CRM
  dev against `http://localhost:3000`).
- `AI_REVIEW_FORMAT` — `v3` (default) or `v2` for the legacy flat
  prompt.
- `AI_REVIEW_CONFIDENCE_THRESHOLD` — float, default `0.7`.
- `AI_REVIEW_DEBUG` — `true` for verbose ai-review logging.

### Build (Windows installer)

```bash
npm run build:win
```

Produces `dist/Inspection Review Setup <version>.exe` (~280 MB,
mostly Playwright's bundled Chromium). Mac build: `npm run build:mac`.

### Architecture pointers

- `src/main.js` — Electron main process. IPC handlers for
  `electron-login`, `electron-logout`, `auth-state`,
  `analyze-inspections`, `send-to-crm`, `fetch-inspection`,
  `open-external-url`. `callClaude` posts `{messages}` to the CRM
  proxy at `/api/inspections/ai-analyze`.
- `src/credential-store.js` — `safeStorage` (DPAPI on Windows) over
  `credentials.bin` in `%APPDATA%\Inspection Review\`. Schema-versioned;
  plaintext fallback when `safeStorage.isEncryptionAvailable()` is
  false. `preferences.json` (plaintext) caches `lastEmail` for the
  login screen prefill.
- `src/preload.js` — exposes `window.api.*` to the renderer.
- `src/index.html` — renderer (login screen, main UI, results view).
- `src/review-v3.js` — V3 issue-bucketing helpers (Cleaning,
  Make-Ready, Exterior) for the categorized prompt.

### Releases

Tagged versions on `master`. Installer downloads on the
[releases page](https://github.com/joshisbell-jpg/inspection-review-app/releases).
The CRM page links to `/releases/latest` so inspectors always land on
the newest published version.

### Server-side counterparts

Authentication, AI analysis, and review persistence are all owned by
the [KeepSimpleCRM](https://www.keepsimplecrm.com) backend (private
repo). Endpoints this app calls:

- `POST /api/auth/electron-login` — credential auth, returns per-user
  API key + organization metadata.
- `POST /api/auth/electron-logout` — Bearer-authed key revoke.
- `POST /api/inspections/ai-analyze` — Bearer-authed Anthropic proxy.
- `POST /api/inspections/ai-review` — Bearer-authed save-to-CRM.
