# Inspection Review — Setup Guide for Inspectors

This guide walks you through installing the Inspection Review desktop app and using it to review move-out and move-in inspections.

The app runs on Windows. macOS support is in the codebase but not currently distributed via the public release.

---

## 1. Install

1. Open the CRM at <https://www.keepsimplecrm.com/ai-review/electron>.
2. Click **Download Latest** — this opens the GitHub release page in your browser.
3. Download `Inspection Review Setup 1.2.0.exe` (about 280 MB).
4. Run the installer.

### Windows SmartScreen warning

The installer is unsigned, so the first time you run it Windows will show a blue **"Windows protected your PC"** dialog.

1. Click the small **More info** link.
2. Click **Run anyway**.

This warning appears once per machine. After install, the app launches normally.

---

## 2. First-time login

1. Launch **Inspection Review** from Start Menu.
2. Sign in with your KeepSimpleCRM email + password.
3. Your credentials are encrypted and stored locally (Windows DPAPI / `safeStorage`) so you don't need to log in every time.

The app does not need any `.env` editing or per-machine API key setup. The login screen handles everything.

If your account is locked, suspended, or deactivated, the login screen surfaces the reason. Contact your account admin.

---

## 3. Three ways to review an inspection

The app supports three paths into a review. Pick whichever matches the inspection's source.

### A. Web upload (small PDFs only — under 25 MB)

For occasional reviews on a borrowed machine, you can use the web app directly:

1. Sign in to <https://www.keepsimplecrm.com>.
2. Navigate to **Inspections → New V4 Review** in the sidebar.
3. Upload the move-out PDF (and optionally the move-in PDF for comparison).
4. Optionally enter a property address override or context fields.
5. Click **Run V4 review**.

If your PDF exceeds 25 MB, the web upload form will show a red banner directing you to use the desktop app instead.

### B. Desktop PDF upload (any size)

This is the main path for full inspections. Large PDFs (162 MB+ QC files) work here because the PDF text is parsed locally on your machine — only the extracted text travels to the AI proxy.

1. Open the desktop app (signed in).
2. Click **Upload Inspection PDF** under the **Current Inspection** card.
3. Select your move-out PDF.
4. Optionally upload one or more move-in PDFs under **Previous Inspections**.
5. Optionally fill out **Add property context** with tenant name, deposit, lease dates.
6. Click **Step 2: Process Inspection**.

The app will:
- Parse your PDFs locally.
- Send the extracted text (NOT the PDF bytes) to the AI proxy.
- Render an 8-bucket V4 review with cascade decisions, per-item decisions, and Photo Review flags.

### C. Deep-link from the web (URL-scrape path)

For AppFolio or zInspector inspections accessed by URL, the web app can hand off to the desktop app:

1. Sign in to the CRM.
2. Navigate to **Inspections → New V4 Review**.
3. Click the **Link to Inspection** tab.
4. Pick the platform (AppFolio or zInspector).
5. Paste one or more inspection URLs (one per line, up to 10).
6. Click **Send to Electron**.

Your browser will hand the URL list to the desktop app via the `inspection-review://` custom protocol. The app focuses, populates the URL fields, and you click **Step 1: Login to Platforms** then **Step 2: Process Inspection**.

This requires the desktop app to be installed *before* you click the deep link. If nothing happens when you click Send to Electron, install the app first.

---

## 4. Decision flow

V4 reviews are organized into 8 buckets:

- **Cleaning**, **Light Bulbs**, **Pest Control** — single-approval (one decision cascades to every item).
- **Make-Ready**, **Other Issues** — per-item (each issue gets its own decision).
- **Carpet** — mixed (Carpet Cleaning is single-approval, Carpet Damage is per-item).
- **Exterior Lawn Care** — mixed (Grass / Trees / Flowerbeds are single-approval; Other is per-item).
- **Exterior Make-Ready** — per-item.

For each decision, choose:

| Button | Meaning |
|--------|---------|
| **Tenant** | Charge the tenant's deposit. |
| **Owner** | Owner-funded repair / maintenance. |
| **Review** | Normal wear-and-tear or undecided — needs a second look. |
| **Skip** | Ignore this item entirely (per-item decisions only). |

**Skip is mutually exclusive with liability.** Selecting Skip clears any liability decision; selecting a liability button clears Skip.

**Single-approval cascade:** for buckets like Cleaning, picking **Tenant** at the bucket header applies that decision to every item in the bucket. Items show "Cascaded from bucket" text instead of their own buttons.

---

## 5. Photo Review flagging

The AI flags items it isn't sure about (low confidence, visual-only descriptions, multi-issue text). Flagged items appear with:

- A red **flag icon** next to the room name.
- A red **left-border accent** on the issue card.
- A **tooltip** explaining why it was flagged + a "Check PDF page N" hint pointing you to the source page.

Open the original PDF to that page, decide based on the photo, then assign the decision yourself.

---

## 6. Saving to CRM

When you've made decisions on every item:

1. Verify the **property address** at the top.
2. Click **Save to CRM**.
3. The app POSTs the V4 decision map to `/api/inspections/v4/save`.
4. The server applies the cascade + Skip mutex and persists the merged review.
5. The save button changes to **Saved to CRM**.

The saved review appears in the CRM at <https://www.keepsimplecrm.com/ai-review> in the Saved Reviews list. Click any row to view the V4 detail page (read-only by default; lock toggles available to admins).

You can also export decisions locally without saving:

- **Copy Owner Email** — formatted email summary of tenant + owner items, copied to your clipboard.
- **Copy Tenant Email** — tenant-facing summary of items charged to them.
- **Export JSON** — full review + decisions as a downloadable JSON file.

---

## 7. After saving

The review now lives in the CRM. Open the URL printed in the success state, or browse to the Saved Reviews list yourself.

Next steps for each tier:

- **Tenant items** → use the email export to send the tenant their itemized charges, or paste into your existing deposit-disposition workflow.
- **Owner items** → send to the owner via the **Copy Owner Email** export.
- **Review items** → flag for second look in your usual handoff pipeline.

---

## 8. Troubleshooting

### "Auth expired" — sent back to login mid-review

Your API key was revoked or rotated server-side, or your session timed out.

1. Sign back in.
2. Your in-progress decisions are preserved in memory (auth-expired does NOT reset state).
3. Click **Save to CRM** again.

### Save to CRM returns "Permission denied"

Your role doesn't have edit access to the inspections workflow. Ask your account owner or admin to grant you `inspections.review` department-edit (or higher) permission.

### Deep link from web doesn't open the app

The custom protocol registration happens during installer setup. If you installed before v1.2.0 (which added the registry write), reinstall the latest version and try again.

### Pre-existing labels look wrong

If "Pre-existing" badges are appearing on items the AI should have flagged as NEW, try uploading a move-in PDF for comparison mode. Without a move-in baseline, all items default to whichever side the AI has stronger evidence for from the inspection text alone.

### Large PDF parse fails or hangs

Some scanned-only PDFs (no embedded text) will produce 0 chars from `pdf-parse`. The app will report 0 issues. Workaround: OCR the PDF first (Adobe Acrobat → Recognize Text), save, retry.

### Logout / fresh start

- **Logout** (top-right of app): revokes your API key on the server, wipes credentials.bin, returns to login screen. Resets in-memory inspection state.
- **New Review** (action bar): clears the current review without touching credentials. Use to start a second inspection in the same session.

---

## 9. Updating to new versions

Click **Download Latest** at <https://www.keepsimplecrm.com/ai-review/electron> and run the new installer. Your saved credentials and preferences carry over.

---

## Appendix — what the app sends to KeepSimpleCRM

When you click Save to CRM on a V4 review, the app POSTs:

```
POST /api/inspections/v4/save
Authorization: Bearer ksc_live_<your-per-user-key>

{
  "sessionId": "<uuid>",
  "v4Result": { ...V4IssuesBlob from /api/inspections/v4/run... },
  "decisions": {
    "bucketDecisions": { "<compositeKey>": "tenant" | "owner" | ... },
    "itemDecisions": { "<issueId>": "tenant" | ... },
    "itemSkipped": { "<issueId>": true }
  },
  "propertyAddress": "...",
  "addressSource": "appfolio" | "zinspector" | "fallback" | "caller" | "empty",
  "parseStats": { "pages": 215, "chars": 102000 },
  "tokenUsage": { "input": 41000, "output": 8200 },
  "context": { "unit": "...", "tenant": "...", "leaseDuration": "..." }
}
```

PDFs themselves never leave your machine in the heavy-PDF path — only the extracted text travels to the AI proxy at `/api/inspections/ai-analyze` (during the V4 run on the desktop app) or `/api/inspections/v4/run` (the server-side V4 endpoint that handles the heavy-PDF text path).
