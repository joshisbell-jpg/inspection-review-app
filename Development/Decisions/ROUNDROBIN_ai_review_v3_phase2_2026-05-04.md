# ROUNDROBIN: AI Review V3 Phase 2 — Categorized Emission + Ollama Removal

**Date:** 2026-05-04
**Repo:** inspection-review-app (Electron)
**Sequenced on:** keepsimplecrm Phase 1.5 (commit 9bc2f1f)
**Implementation commit:** 0453401 (`feat(ai-review): V3 categorized emission + Ollama removal (Mission 3 Phase 2)`)
**Status:** Shipped to origin/master, end-to-end verified locally
**Production verification:** Pending Mission 7 (per-user API keys)

---

## Context

Phase 1.5 (CRM, commit 9bc2f1f) added a discriminated-union POST handler at `/api/inspections/ai-review` that accepts both V2 and V3 payloads, with V3 as the new categorized format (cleaning / make_ready / exterior buckets, per-issue confidence, group-by-key, audit trail). Phase 1 (CRM, commit 892c38a) made the LIST query format-aware. Together those two CRM-side phases laid the schema groundwork.

Phase 2 (this commit) is the Electron-side work that **emits** V3 payloads to feed the Phase 1.5 endpoint. It also removes the dormant Ollama/Gemma local-AI path entirely — that path was PIN-gated behind `1988`, never used in production, and the local-Gemma hardware was impractical for a 50-100 issue inspection at acceptable latency.

This is a load-bearing piece of the Mission 3 rollout because it's the first time the human reviewer sees categorized output. Phase 3 will introduce a bucket-aware UI; Phase 2 keeps the existing flat-list UI by translating V3 → V2 for display.

---

## Q1-Q15 Design Decisions (locked during recon)

### Q1: groupKey emission

**Decision:** AI-emitted with light post-hoc normalization (lowercase, whitespace → `-`, strip non-alphanumeric/hyphen).

**Rationale:** AI is good at recognizing "this is the same KIND of issue across rooms" (semantic similarity). Post-hoc normalization in JS handles formatting jitter (case differences, em-dash vs hyphen, trailing whitespace). Going either fully AI-emitted or fully deterministic would lose accuracy: deterministic alone can't tell that "Baseboards — dusty" and "Dusty baseboards" are the same group.

### Q2: pageReferences

**Decision:** AI emits when visible (page numbers in screenshots like "Page 3 of 149"); empty array `[]` otherwise.

**Rationale:** Page numbers are reviewer-critical for jumping to the source page in a 149-page PDF. When the AI can see them, capture them. When it can't (no visible page header), an empty array is honest — better than fabricating.

### Q3: liability='unassigned' as terminal state

**Decision:** When AI is genuinely unclear between tenant/owner/normal_wear, it emits `liability: 'unassigned'` AND `isNewSinceMoveIn: false` (defensive). The orchestrator preserves the AI's `'unassigned'` even in comparison mode.

**Rationale:** `'unassigned'` is a real terminal state, not a placeholder. It surfaces in Phase 3 UX as a separate counter from `unreviewed` (see Counter-axes lesson below). Conflating "AI gave up" with "human hasn't looked yet" loses information the reviewer needs.

### Q4-Q6: Emission-time defaults

**Decision:** Every issue at emission time has `liabilityDefaultedBy: 'auto'`, `isSkipped: false`, `edits: []`.

**Rationale:** These are the audit-trail anchors. `liabilityDefaultedBy: 'auto'` means "the system assigned this liability without human input"; the reviewer can flip it to `'reviewer'` later. `edits: []` is the empty audit log; subsequent edits append entries.

### Q7: Auto-default rule

**Decision:**
- `isNewSinceMoveIn === true` → `liability: 'tenant'`
- `isNewSinceMoveIn === false` → `liability: 'owner'`
- AI genuinely unclear → `isNewSinceMoveIn: false` AND `liability: 'unassigned'`

**Rationale:** This codifies how property managers default-assign liability under Texas property law. New damage during tenancy → tenant; pre-existing damage → owner. The AI's `isNewSinceMoveIn` flag drives the auto-default; reviewer overrides as needed. `'unassigned'` is the safety-valve for cases where the AI shouldn't guess.

### Q8: Severity enum

**Decision:** Strict enum `'minor' | 'moderate' | 'major'`. Coerce `'low'→'minor'`, `'medium'→'moderate'`, `'high'/'severe'/'critical'→'major'`. Anything unexpected → `'moderate'` with `console.warn`.

**Rationale:** Schema discipline. AI sometimes drifts to alternate vocabularies (`'low'`, `'high'`); defensive coercion keeps the V3IssuesBlob shape valid without crashing the save. The warn surfaces drift in the field so we can spot prompt regressions.

### Q9: Bucket + confidence + keyword fallback

**Decision:**
- AI emits `bucket` (cleaning/make_ready/exterior) + `bucketConfidence` (0.0-1.0)
- If `bucketConfidence < AI_REVIEW_CONFIDENCE_THRESHOLD` (default 0.7): run keyword matcher and override
- If keyword match: set `bucketAssignedBy: 'deterministic-fallback'`
- Otherwise: keep AI's bucket, set `bucketAssignedBy: 'ai'`

Keyword precedence: **Exterior → Make-Ready → Cleaning → default Make-Ready**. Special case: `\bhair\b` regex (Cleaning) only fires after Make-Ready, so "hairline crack" stays in Make-Ready (matched by "crack" in Make-Ready keywords).

**Rationale:** AI is fast on clear cases (90%+ confidence) but unreliable on borderline cases (stains that might clean off vs need re-finishing). Keyword fallback is deterministic and cheap. The audit-trail `bucketAssignedBy` flag tells the reviewer (and Phase 3 UI) where the bucket came from.

### Q10: Renderer compatibility — Option A (V3 → V2 display translation)

**Decision:** Keep the existing flat-list renderer. Translate V3IssuesBlob → V2-shaped display array (cleaning → make_ready → exterior → manualIssues). Each display row carries `_v3Id` field. At save time, walk the displayed array and back-map each reviewer decision to the underlying V3Issue by `_v3Id`.

**Rationale:** Phase 2 is data-shape change, not UX change. The bucket-aware UI is Phase 3+ scope. Translation pattern minimizes renderer churn (10-30 lines vs. a full rewrite) while preserving full V3 semantics on the wire. The `_v3Id` back-mapping is the load-bearing correctness primitive — see implementation pattern below.

### Q11: Ollama — REMOVE entirely

**Decision:** Delete all Ollama/Gemma code from main.js, preload.js, and index.html. No feature flag, no gate.

**Rationale:** The Ollama path was PIN-gated behind `1988` (only Josh knew the PIN), never used in production, and the local-Gemma hardware (Mac Mini M2) was too slow for 50-100 issue inspections. Carrying it forward would tax future missions (Mission 3 V3 prompt would need TWO implementations; Mission 4+ same). Net cost > net benefit. Removed.

### Q12: Confidence threshold env var

**Decision:** `AI_REVIEW_CONFIDENCE_THRESHOLD=0.7` (default), tunable via `.env`.

**Rationale:** 0.7 is a calibrated default — high enough that confident wrong buckets don't slip through, low enough that the keyword fallback isn't doing 80% of the work. Tunable for experimentation.

### Q13: groupId / id stability

**Decision:** Both `crypto.randomUUID()`. NOT stable across runs.

**Rationale:** Each save is its own snapshot. If you save the same inspection twice, the V3 blob has different ids. Phase 4 may want stable ids if cross-save diffing becomes a feature; not needed for Phase 2.

### Q14: Single-inspection mode liability

**Decision:** Every issue gets `liability: 'unassigned'` when there's no comparison baseline (no move-in inspection provided).

**Rationale:** Without a baseline, you can't tell if an issue is new-since-tenancy or pre-existing. Auto-defaulting to tenant or owner would frequently be wrong. Forcing 'unassigned' surfaces that the reviewer needs to manually classify each issue.

### Q15: Auth token

**Decision:** Verify at test time, fix on failure if needed. Production save requires Mission 7 per-user keys.

**Rationale:** Phase 2 dev token works against local CRM (verified). Production save (against `keepsimplecrm.com`) requires per-user keys to avoid embedding the dev token in distributed Electron builds. Mission 7 covers that.

### Default emission format

`AI_REVIEW_FORMAT=v3` with soft fallback to V2 on any V3 path failure.

### Token budget

`max_tokens` bumped from 16384 → 32768. V3 needs more headroom because each issue carries `bucket`, `bucketConfidence`, `groupKey`, `groupLabel` in addition to V2's existing fields.

---

## Implementation pattern: V3 attempt → V2 soft fallback

```
analyze-inspections IPC handler:
├─ if AI_REVIEW_FORMAT=v3:
│  ├─ try:
│  │  ├─ buildV3*Messages(...)
│  │  ├─ callClaude(v3Messages)        ← cost: ~$0.80-2.00
│  │  ├─ parseAnalysisResponse(...)
│  │  ├─ assert Array.isArray(parsedAi.issues)
│  │  ├─ assembleV3Blob(...)            ← throws on bad shape
│  │  ├─ transformV3ToV2ForDisplay(...)
│  │  └─ return {format:'v3', issues:V3Blob, _displayShape}
│  └─ catch v3Error:
│     ├─ console.warn (always-on)
│     └─ fall through to V2 path
│
└─ V2 path (default if format=v2, or fallback):
   ├─ buildComparisonMessages(...)      ← unchanged from before this PR
   ├─ callClaude(v2Messages)            ← cost: ~$0.80-2.00
   ├─ parseAnalysisResponse(...)
   └─ return {format:'v2', overall_condition, summary, issues:[...]}
```

**Failure modes that trigger V3 → V2 fallback:**
- Network error in `callClaude(v3Messages)` (timeout, DNS, refused)
- `parsedAi` is null/undefined
- `parsedAi.issues` is not an array
- `assembleV3Blob` throws (description missing, non-object input)

**Cost analysis:** A V3 failure → V2 fallback = 2 paid API calls (~$1.60-4.00). Bounded. Acceptable in exchange for prompt-failure resilience. The always-on warn surfaces the failure cause so we can iterate prompts.

**Known characteristic** (deferred YELLOW from round-robin): when `parseAnalysisResponse` returns its documented fallback shape (`{overall_condition: 'unknown', summary: 'AI returned a response but it could not be parsed as JSON.', issues: []}`), V3 path passes `Array.isArray([])`, returns success with 0 issues, and does NOT fall back to V2. Same pathology exists in V2. Forcing V3 → V2 retry on this case would double API spend without gain since both formats fail equally on AI gibberish. Cross-cutting fix is a separate feature.

---

## Implementation pattern: V3 → V2 display translation (Option A) with `_v3Id` back-mapping

```
Main process (V3 path):
└─ assembleV3Blob → V3IssuesBlob with V3Issues having id=randomUUID()
   └─ transformV3ToV2ForDisplay → V2-shape with _v3Id on each row
      └─ result = {format:'v3', issues:V3Blob, _displayShape:{issues:[...]}}
         └─ IPC → renderer (JSON-serialized)

Renderer:
└─ results = analysisResult.result
   └─ displayIssues = results._displayShape.issues   (V3 case)
      OR  results.issues || []                       (V2 case)
      └─ user clicks decisions
         └─ reviewDecisions[i] = 'tenant' | 'owner' | 'wear' | 'skip'

Save to CRM (renderer → main):
└─ sendToCrm({result:results, reviewerDecisions:displayIssues.map(...)})
   └─ IPC → main (JSON-serialized; _v3Id round-trips)

Main process (send-to-crm V3 branch):
└─ displayedIssues = result._displayShape.issues
   └─ applyReviewerDecisions(result.issues, reviewerDecisions, displayedIssues)
      ├─ deep clone V3Blob
      ├─ build byId map: V3Issue.id → V3Issue (across all buckets + manualIssues)
      ├─ for i in displayedIssues:
      │  ├─ v3Id = displayedIssues[i]._v3Id
      │  ├─ decision = reviewerDecisions[i].decision
      │  ├─ target = byId.get(v3Id)
      │  ├─ if target missing: unmappedCount++
      │  └─ else: mutate target per decision (liability + defaultedBy='reviewer', or isSkipped=true)
      └─ recompute totals (totalIssues, totalSkipped, totalUnreviewed)
```

**Critical correctness property:** display order ≠ AI emission order. The AI may emit issues in inspection-walk order; the display reorders by bucket (cleaning → make_ready → exterior). Despite this reordering, decisions land on the correct V3Issue because lookup is by `_v3Id` (immutable string), not by index. **Verified by smoke test:** input order [stain, hole, sprinkler, mirror] → display order [stain, mirror, hole, sprinkler] → reviewer decisions map correctly to the original V3Issues.

**Two unconditional warns** (round-robin findings, both shipped in this commit):

1. `[ai-review] V3 save: result marked v3 but _displayShape is missing or empty — reviewer decisions will not be applied. This indicates an internal bug in analyze-inspections.`
2. `[ai-review] N reviewer decision(s) failed to map to V3 issues by _v3Id — decisions LOST. Likely cause: _v3Id mismatch between display shape sent to renderer and V3 blob in main.`

Both fire outside the `AI_REVIEW_DEBUG` gate. These are data-integrity warnings, not telemetry — silent loss of reviewer decisions is exactly what the human is paid to prevent.

---

## Ollama removal rationale

| Reason | Detail |
|---|---|
| **Never used in production** | PIN-gated behind `1988`. Only Josh knew the PIN. Zero saves used the Ollama path. |
| **Hardware impractical** | Local Gemma 4 (gemma4:e4b) on Mac Mini M2 took 8-15 minutes per 50-100 issue inspection — vs. Claude's 30-60 seconds. Reviewer can't wait 15 minutes for an analysis to start. |
| **Future-mission tax** | Mission 3 V3 prompt would need a second implementation (Ollama-shaped prompt). Mission 4+ same. Carrying both paths forward would 2x the prompt-iteration cost. |
| **Output quality drift** | Gemma's "alternate format" (`detailed_issues_by_area`) required `normalizeOllamaResponse` to coerce into the expected shape. Gemma sometimes returned malformed JSON requiring `addOllamaJsonEnforcement` wrapping. Maintenance burden. |
| **Code surface area** | Ollama path was ~400 lines across main.js (5 functions + branch), index.html (PIN gate UI + backend toggle modal, ~310 lines), preload.js (3 IPC bindings). Removing simplifies the entire stack. |

**Verification grep:** `grep -rEi "(ollama|gemma|OLLAMA)" --include="*.js" --include="*.html" --include="*.json" --include="*.md"` (excluding node_modules/dist/playwright-browsers) returns **zero matches** post-commit.

---

## Round-robin: 7 roles, 5 GREEN + 2 YELLOW (both closed)

| Role | Verdict | Notes |
|---|---|---|
| Reviewer R1 | 🟡 → 🟢 (closed) | Found YELLOW: missing-`_displayShape` silent loss. Closed by unconditional warn. |
| Architect R1 | 🟡 (deferred) | Empty-issues V3 fallback gap — same pathology as V2, defer. |
| Technical R1 | 🟢 | All 5 edge cases on `applyReviewerDecisions` handled. max_tokens audit clean. |
| Reviewer R2 | 🟢 | Independent re-trace of `_v3Id` round-trip and `in_move_in` semantic confirmed. |
| Architect R2 | 🟢 | Format-mismatch shape validation noted as Phase 3+ defensive hardening. V2 backward compat byte-identical. |
| Technical R2 | 🟡 → 🟢 (closed) | Found YELLOW: unmapped warn was inside debug gate. Closed by moving outside gate (data loss ≠ telemetry). |
| QA Final | 🟢 | All load-bearing items GREEN. Aggregated 2 closed YELLOWs + 2 deferred. |

**Items covered:**
1. `_v3Id` mapping correctness across IPC boundary — **verified**
2. `in_move_in` semantic correction — **verified end-to-end**
3. Soft fallback completeness — **mostly clean**, empty-issues case deferred (matches V2 behavior)
4. Format mismatch protection on send-to-crm — **closed by warn #1**
5. `applyReviewerDecisions` edge cases — **all 5 cases handled**
6. V2 backward compat byte-identical — **verified**
7. `max_tokens 32768` only hardcoded value — **verified, only one match**
8. Cost burn awareness — **zero API calls during review**

---

## Lessons forward

### Lesson 1: `in_move_in` semantic correction (load-bearing)

The Phase 2 mission spec specified `in_move_in = 'yes' if isNewSinceMoveIn=true, 'no' if false`. This was **reversed** vs. the renderer authoritative semantics:

- Renderer (`index.html` showResults): `in_move_in === 'no'` → "NEW — Not in move-in inspection"
- Renderer: `in_move_in === 'yes'` → "Also in move-in"

Since `isNewSinceMoveIn=true` means "new since move-in" (i.e., NOT present in move-in inspection), the correct mapping is `isNewSinceMoveIn=true → in_move_in='no'`. Implementation followed renderer semantics; spec was corrected during STOP GATE 1 and approved.

**Lesson:** When a plan touches data that flows into existing UI, trace renderer semantics before implementing. The renderer is the source of truth for display labels — any new emission code must match what the renderer expects, not what the spec assumes. Had this gone unchecked, every NEW issue would have rendered as "Also in move-in" and tenant/owner decisions would have been silently flipped.

### Lesson 2: "Loose [thing]" defaults to make_ready (calibration observation, not bug)

Smoke test case: `keywordBucketFor("Loose hair in drain")` returns `'make_ready'` — not Cleaning. This is **by design**: the keyword precedence is Exterior → Make-Ready → Cleaning → default. "loose" is in MAKE_READY_KEYWORDS, so it fires before Cleaning is evaluated.

A property manager handling "loose hair in drain" probably wants the drain stopper inspected/repaired (not just the hair removed). Conservative default toward Make-Ready means the work order gets routed to the maintenance queue rather than the cleaning queue.

**Lesson:** Document keyword-fallback precedence as part of the V3 contract. Phase 3 reviewers may see a few "Cleaning-looking" items in Make-Ready and need to understand the why. Calibration observations like this should live in the ADR, not be discovered as bug reports.

### Lesson 3: Counter-axes documentation (liability VALUE vs review STATE)

`V3DepositAssessment` has both `unassigned` (count of issues with `liability='unassigned'`) and `unreviewed` (count of issues with `liabilityDefaultedBy='auto'` AND `!isSkipped`). These are **independent dimensions**:

- `unassigned > 0` means AI gave up trying to classify those issues (terminal state — needs manual review)
- `unreviewed > 0` means the human reviewer hasn't touched those issues yet (transient state — will decrement as decisions are made)

Both can be high simultaneously (e.g., AI emitted 30 'unassigned' liabilities and the reviewer hasn't started yet → `unassigned=30, unreviewed=30`). Or `unassigned=30, unreviewed=0` (reviewer reviewed every issue but assigned none of the unassigned ones — unusual but valid).

**Lesson:** When a single concept ("review status") has multiple axes, name them distinctly and document the matrix. Conflating them loses information. Phase 3 UI will need to surface both axes (probably as separate badges).

### Lesson 4: Test discipline — `curl` smoke check before save tests

V2 test failure mode: `Save failed with "Failed to save: fetch failed"`. The "fetch failed" message (vs. an HTTP 4xx/5xx) is a **network-layer signal**: DNS failed, connection refused, no route. First diagnosis thought should be "is the dev server up?", not "is auth wrong?".

In this case the CRM dev server (Next.js on `localhost:3000`) wasn't running. A 5-second `curl http://localhost:3000/api/inspections/ai-review` smoke check would have caught it before Josh launched Electron.

**Lesson:** Prepend a `curl <CRM_API_URL>/api/inspections/ai-review` smoke check before any Electron save test. If the curl returns DNS error or connection refused, the test infrastructure is broken — fix that before launching the app. Costs 5 seconds, saves 5+ minutes of false-positive diagnosis.

---

## Deferred items (known characteristics, not regressions)

| Item | Classification | Why deferred |
|---|---|---|
| Empty-issues V3 fallback gap | Same pathology as V2 — not a regression | Cross-cutting fix; either both formats need it or neither |
| Unknown decision strings (forward-compat) | Acceptable — CRM Zod is source of truth | Stale Electron builds will silently drop unknown decisions; deployment-time guidance documents this |
| Mission 6: Saved Review Edit Mode | Phase 4+ scope | No editing after Save to CRM — gap noted by Josh, separate mission |
| Mission 7: Per-User API Keys | Production-blocker, separate mission | Phase 2 verified locally only; production save against keepsimplecrm.com requires per-user tokens |
| Tenant/Owner/All print-or-download buttons | UX scope, Phase 3+ | Gap on review detail page; separate work item |
| Drag-and-drop file upload broken in Electron | Low priority | Click-to-select works; backlog |
| "Possible duplicate" yellow badge on test runs | Working as designed (Mission 5) | Test runs against same address legitimately trigger the badge — not a bug |

---

## Production verification gap (explicit)

**Phase 2 is verified locally against the keepsimplecrm dev server.** End-to-end V2 path saved successfully (62 issues, 1T/6O/0W/2S, POST 201 in 743ms). End-to-end V3 path saved successfully (62 issues, 1T/4O/1W/0S, AI emitted valid V3 JSON with all canonical fields, _v3Id round-trip 6/6 mapped clean).

**Production save (against `keepsimplecrm.com`) is NOT verified.** It requires Mission 7 (per-user API keys) before inspectors can use V3 against production:
- Current `CRM_API_TOKEN` in `.env` is the dev token, hardcoded for local testing
- Distributing it in the packaged Electron `.exe` would expose the token to all users
- Mission 7 will add per-user key issuance + rotation

Until Mission 7 ships, Phase 2 is **dev-only verified**. Inspectors should continue using the V2 path against production, or the existing Phase 1.5 V3 path tested by Josh manually with his own dev token.

---

## Verification artifacts

### V2 end-to-end test (local)
- Format: V2 (env `AI_REVIEW_FORMAT=v2`)
- Total issues: 62
- Decisions: 1T / 6O / 0W / 2S
- POST: 201 in 743ms
- CRM list: row 2

### V3 end-to-end test (local)
- Format: V3 (env `AI_REVIEW_FORMAT=v3`)
- Total issues: 62
- Decisions: 1T / 4O / 1W / 0S
- AI emitted valid V3 JSON with all canonical fields (bucket, bucketConfidence ≥ 0.9, groupKey, groupLabel, pageReferences, isNewSinceMoveIn)
- V3 assembly: total=62, cleaning=5, make_ready=48, exterior=9, keyword_fallback=0 (AI was confident on all 62)
- 6 reviewer decisions clicked, 6 mapped, 0 unmapped (`_v3Id` round-trip clean)
- Phase 1.5 discriminated union accepted V3 payload
- CRM list: row 1

### Regression checks
- Wickiup V2 row from yesterday still loads — no regression
- Mission 5 duplicate-detection still works

### Static verification
- `node --check` clean on `src/main.js`, `src/preload.js`, `src/review-v3.js`
- `vm.createScript` of `src/index.html` inline `<script>` (~31KB) — clean
- Ollama removal grep — zero matches across all source files
- `npm run start` boots Electron cleanly

### Unit tests (review-v3 module)
- Keyword bucketing precedence verified (8 cases)
- Group collapsing across rooms (2 stains in different rooms → 1 group with shared groupId)
- Severity coercion (`low→minor`, `medium→moderate`, `high→major`, unknown→`moderate`)
- `defaultLiabilityFor` for both modes (comparison and single-inspection)
- `assembleV3Blob` end-to-end (4 issues → bucket-routed → counts correct)
- `transformV3ToV2ForDisplay` carries `_v3Id` and correct `in_move_in` mapping
- `applyReviewerDecisions` with: clean (2 mapped, 0 unmapped), corrupted `_v3Id` (warn fires), missing `_displayShape` (warn fires)

---

## Diff stat

```
.env.example   |   5 +
src/index.html | 244 +-
src/main.js    | 697 +-
src/preload.js |   5 -
src/review-v3.js (new) | 559
5 files changed, 994 insertions(+), 536 deletions(-)
```

Net: +458 lines (V3 module is 559 lines; Ollama removal cleared ~400 lines from main.js + ~310 from index.html).

---

## Files of record

- **Implementation commit:** 0453401 in `joshisbell-jpg/inspection-review-app`
- **ADR (vault):** `C:\Users\joshi\OneDrive\Documents\ClaudeContext\ClaudeContext\Development\Decisions\ROUNDROBIN_ai_review_v3_phase2_2026-05-04.md`
- **ADR (repo):** `Development/Decisions/ROUNDROBIN_ai_review_v3_phase2_2026-05-04.md` (this commit)
- **Recon Q&A:** lives in chat history (Q1-Q15)
- **Round-robin verdicts:** STOP GATE 3 in chat history; aggregated above

Byte-identical between vault and repo copies. SHA256 verified at write time.
