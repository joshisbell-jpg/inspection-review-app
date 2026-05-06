/**
 * Credential Store — Mission 7.2 Phase B
 *
 * Owns all on-disk auth state for the Electron app. Two files in
 * app.getPath('userData'), which on Windows resolves to
 * %APPDATA%\Inspection Review\:
 *
 *   - credentials.bin   Encrypted blob via Electron safeStorage. Holds the
 *                       per-user CRM API key and the cached user/org/server
 *                       metadata returned by /api/auth/electron-login.
 *
 *   - preferences.json  Plaintext JSON. Holds non-secret prefs (currently
 *                       only lastEmail, used to prefill the login screen).
 *
 * Plaintext fallback: when safeStorage.isEncryptionAvailable() returns
 * false (rare on Windows; possible on locked-down corporate machines or
 * Wine), credentials.bin is written as plaintext JSON with a console.warn.
 * This is acceptable for the inspector use case (single-user laptops).
 * Reconsider if Mission 7 expands to shared machines.
 *
 * Lifecycle: every public function in this module reads app.getPath, which
 * requires app.whenReady() to have resolved. The IPC handlers that call
 * into here are invoked from the renderer, which can only load after
 * whenReady, so this is safe in normal use. Do not call from top-level
 * main.js code that runs before whenReady.
 */

const fs = require('fs').promises;
const path = require('path');
const { app, safeStorage } = require('electron');

const SCHEMA_VERSION = 1;
const REQUIRED_CRED_FIELDS = [
  'plaintextKey',
  'userId',
  'userName',
  'userEmail',
  'organizationId',
  'organizationName',
  'serverWwwUrl',
];

function credentialsPath() {
  return path.join(app.getPath('userData'), 'credentials.bin');
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

/**
 * Read and decrypt credentials.bin.
 *
 * Returns the credentials object on success, or null if the file is missing,
 * unreadable, undecryptable, unparseable, or fails schema validation.
 *
 * On any corruption-shaped failure (decrypt fail, JSON parse fail, schema
 * mismatch, missing required fields), the file is deleted before returning
 * null and a [auth] warning is logged. ENOENT (file simply doesn't exist)
 * is silent.
 *
 * @returns {Promise<object|null>}
 */
async function readCredentials() {
  const file = credentialsPath();
  let raw;
  try {
    raw = await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn('[auth] credentials.bin read error: ' + err.message);
    return null;
  }

  let jsonStr;
  if (safeStorage.isEncryptionAvailable()) {
    try {
      jsonStr = safeStorage.decryptString(raw);
    } catch (err) {
      await deleteCorrupt(file, 'decryption failed: ' + err.message);
      return null;
    }
  } else {
    // Plaintext fallback: file was written without encryption. Read as utf8.
    //
    // Migration edge case: if a file was previously written ENCRYPTED on this
    // machine but isEncryptionAvailable() now returns false (machine
    // migration, profile copy from another machine, DPAPI key rotation), this
    // branch tries to JSON.parse the encrypted bytes, parsing fails, and
    // deleteCorrupt() fires below. The file is removed and the user re-logs
    // in cleanly. End-state is correct, but the resulting warn line will say
    // "JSON parse failed" rather than "encryption state changed" — a
    // potentially confusing log message for whoever debugs the next stale-
    // profile incident. Documented here so they don't chase a phantom JSON
    // bug.
    jsonStr = raw.toString('utf8');
  }

  let creds;
  try {
    creds = JSON.parse(jsonStr);
  } catch (err) {
    await deleteCorrupt(file, 'JSON parse failed: ' + err.message);
    return null;
  }

  if (creds.schemaVersion !== SCHEMA_VERSION) {
    await deleteCorrupt(file, `schemaVersion mismatch (got ${creds.schemaVersion}, expected ${SCHEMA_VERSION})`);
    return null;
  }

  for (const field of REQUIRED_CRED_FIELDS) {
    if (typeof creds[field] !== 'string' || creds[field].length === 0) {
      await deleteCorrupt(file, `missing or invalid required field: ${field}`);
      return null;
    }
  }

  return creds;
}

/**
 * Encrypt and write credentials.bin.
 *
 * Validates that all required fields are present strings before writing.
 * Always stamps schemaVersion=1. Uses safeStorage when available; otherwise
 * writes plaintext JSON with a one-time console.warn.
 *
 * @param {object} creds
 */
async function writeCredentials(creds) {
  for (const field of REQUIRED_CRED_FIELDS) {
    if (typeof creds[field] !== 'string' || creds[field].length === 0) {
      throw new Error(`writeCredentials: missing or invalid required field: ${field}`);
    }
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    plaintextKey: creds.plaintextKey,
    userId: creds.userId,
    userName: creds.userName,
    userEmail: creds.userEmail,
    organizationId: creds.organizationId,
    organizationName: creds.organizationName,
    serverWwwUrl: creds.serverWwwUrl,
    createdAt: creds.createdAt || new Date().toISOString(),
  };

  const jsonStr = JSON.stringify(payload);
  const file = credentialsPath();

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(jsonStr);
    await fs.writeFile(file, encrypted);
  } else {
    console.warn('[auth] safeStorage encryption unavailable — credentials stored as plaintext. This is a security risk on shared machines.');
    await fs.writeFile(file, jsonStr, 'utf8');
  }
}

/**
 * Remove credentials.bin if it exists. Idempotent: never throws on ENOENT.
 */
async function clearCredentials() {
  try {
    await fs.unlink(credentialsPath());
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[auth] clearCredentials: unlink failed: ' + err.message);
    }
  }
}

/**
 * Read preferences.json. Returns { lastEmail: string | null }. Never throws.
 *
 * @returns {Promise<{lastEmail: string | null}>}
 */
async function readPreferences() {
  try {
    const raw = await fs.readFile(preferencesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastEmail: typeof parsed.lastEmail === 'string' && parsed.lastEmail.length > 0
        ? parsed.lastEmail
        : null,
    };
  } catch (err) {
    return { lastEmail: null };
  }
}

/**
 * Write preferences.json. Always plaintext, always stamps schemaVersion=1.
 *
 * @param {{lastEmail: string}} prefs
 */
async function writePreferences({ lastEmail }) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    lastEmail: typeof lastEmail === 'string' ? lastEmail : null,
  };
  await fs.writeFile(preferencesPath(), JSON.stringify(payload), 'utf8');
}

async function deleteCorrupt(file, reason) {
  console.warn(`[auth] credentials.bin corrupted, removed and re-prompting login (${reason})`);
  try {
    await fs.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[auth] deleteCorrupt: unlink failed: ' + err.message);
    }
  }
}

module.exports = {
  readCredentials,
  writeCredentials,
  clearCredentials,
  readPreferences,
  writePreferences,
};
