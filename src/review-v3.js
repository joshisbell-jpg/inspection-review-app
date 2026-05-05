/**
 * V3 review-format module — Mission 3 Phase 2.
 *
 * V3 categorizes inspection issues into Cleaning / Make-Ready / Exterior buckets,
 * groups identical issues across rooms, and tracks per-issue confidence + audit trail.
 * AI emits a flat issues[] array; this module assembles it into V3IssuesBlob,
 * applies keyword fallback + auto-default liability, and translates to a V2-flat
 * shape for renderer compatibility (Q10 Option A).
 *
 * JSDoc types mirror keepsimplecrm/src/lib/inspections/review-types.ts. Keep them
 * in sync if either side changes.
 */

const crypto = require('crypto');

// ============================================================================
// JSDoc types (mirror keepsimplecrm review-types.ts exactly)
// ============================================================================

/**
 * @typedef {Object} V3IssueEdit
 * @property {string} editedAt              - ISO timestamp
 * @property {'description'|'severity'|'bucket'|'liability'|'rooms'|'pages'} editedField
 * @property {string} oldValue
 * @property {string} newValue
 */

/**
 * @typedef {Object} V3Issue
 * @property {string} id                                    - randomUUID
 * @property {string} groupId                               - randomUUID, shared by issues in same group
 * @property {'cleaning'|'make_ready'|'exterior'} bucket
 * @property {string} room
 * @property {string} area
 * @property {string} description
 * @property {number[]} pageReferences                      - empty array if AI couldn't extract
 * @property {'minor'|'moderate'|'major'} severity
 * @property {boolean} isNewSinceMoveIn
 * @property {string} [moveInNote]
 * @property {number} bucketConfidence                      - 0.0 to 1.0
 * @property {'ai'|'deterministic-fallback'|'reviewer-override'} bucketAssignedBy
 * @property {'tenant'|'owner'|'normal_wear'|'unassigned'} liability
 * @property {'auto'|'reviewer'} liabilityDefaultedBy
 * @property {boolean} isSkipped
 * @property {string} [skippedReason]
 * @property {string} [skippedAt]
 * @property {V3IssueEdit[]} edits
 */

/**
 * @typedef {Object} V3IssueGroup
 * @property {string} groupId
 * @property {string} groupKey
 * @property {string} groupLabel
 * @property {V3Issue[]} issues
 */

/**
 * @typedef {Object} V3IssuesBlob
 * @property {{cleaning: V3IssueGroup[], make_ready: V3IssueGroup[], exterior: V3IssueGroup[]}} buckets
 * @property {V3Issue[]} manualIssues
 * @property {number} totalIssues
 * @property {number} totalSkipped
 * @property {number} totalUnreviewed
 */

/**
 * @typedef {Object} V3DepositAssessment
 * @property {number} tenant
 * @property {number} owner
 * @property {number} normal_wear
 * @property {number} unassigned
 * @property {number} skipped
 * @property {number} unreviewed
 * @property {'v3'} format
 */

/**
 * @typedef {Object} RawAiIssue                             - shape AI emits before orchestration
 * @property {string} room
 * @property {string} area
 * @property {string} description
 * @property {number[]} [pageReferences]
 * @property {string} [severity]
 * @property {boolean} [isNewSinceMoveIn]
 * @property {string} [moveInNote]
 * @property {string} [bucket]
 * @property {number} [bucketConfidence]
 * @property {string} [groupKey]
 * @property {string} [groupLabel]
 */

// ============================================================================
// Keyword lists (Q9 — keyword fallback when bucketConfidence < threshold)
// ============================================================================

const EXTERIOR_KEYWORDS = [
  'exterior', 'outside', 'outdoor', 'yard', 'yards', 'lawn', 'grass',
  'landscaping', 'landscape', 'fence', 'fencing', 'fenced', 'gate', 'shed',
  'garage door', 'driveway', 'patio', 'porch', 'front porch', 'back porch',
  'deck', 'siding', 'soffit', 'fascia', 'gutter', 'gutters', 'downspout',
  'roof', 'rooftop', 'shingle', 'shingles', 'mailbox', 'sprinkler', 'hose bib',
  'spigot', 'water spigot', 'a/c unit', 'ac unit', 'condenser unit',
  'hvac unit', 'trash area', 'walkway', 'sidewalk', 'exterior light',
  'porch light', 'flood light', 'soffit light', 'exterior paint', 'weep hole',
  'weep holes', 'brick veneer', 'stucco', 'window screen', 'storm door',
];

const MAKE_READY_KEYWORDS = [
  'broken', 'break', 'cracked', 'crack', 'cracks', 'chipped', 'chip', 'hole',
  'holes', 'damaged', 'damage', 'torn', 'tear', 'rip', 'ripped', 'missing',
  'loose', 'not working', "doesn't work", 'does not work', "isn't working",
  'inoperable', 'inoperative', 'non-functional', 'needs replacement',
  'needs to be replaced', 'replace', 'needs repair', 'needs repairing',
  'repair', 'patch', 'patching', 'needs patching', 'paint', 'painting',
  'needs paint', 'needs painting', 'touch up', 'touch-up', 'scratched',
  'scratch', 'scratches', 'scratching', 'gouged', 'gouge', 'dented', 'dent',
  'dents', 'warped', 'warp', 'warping', 'sagging', 'sag', 'leaking', 'leak',
  'leaks', 'dripping', 'drip', 'mold', 'moldy', 'water damage', 'water stain',
  'rot', 'rotting', 'rotten', 'rotted', 'bent', 'stripped', 'worn out',
  'wear and tear', 'faulty', 'malfunctioning', 'malfunction', 'burned out',
  'burnt out', 'burnt', 'short circuit', 'electrical issue', 'no power',
  "won't latch", "won't close", "won't lock", "won't open", 'stuck',
  'swollen', 'delaminated', 'delamination', 'peeling', 'peel', 'bubbling',
  'gap', 'gaps', 'caulk', 'caulking', 'needs caulking', 'recaulk', 'grout',
  'regrout', 'needs grout', 'seal', 'sealing', 'needs sealing', 'adjustment',
  'needs adjusting', 'hinge', 'hinges', 'hardware', 'fixture', 'fixtures',
];

const CLEANING_KEYWORDS = [
  'dust', 'dusty', 'dusting', 'dirty', 'dirt', 'soiled', 'soil', 'grime',
  'grimy', 'stain', 'stained', 'staining', 'smudge', 'smudged', 'smudges',
  'smear', 'smeared', 'fingerprint', 'fingerprints', 'debris', 'crumbs',
  'food residue', 'food stain', 'grease', 'greasy', 'soap scum', 'scum',
  'mildew', 'residue', 'buildup', 'build-up', 'build up', 'filthy', 'filth',
  'sticky', 'needs cleaning', 'needs to be cleaned', 'requires cleaning',
  'wipe down', 'needs wiping', 'vacuum', 'needs vacuuming', 'mopping',
  'needs mopping', 'dust accumulation', 'cobwebs', 'cob webs', 'lint',
  'pet hair', 'spilled', 'spill', 'discolored',
];
// 'hair' as bare word uses regex \bhair\b — kept separate so 'hairline crack'
// stays in Make-Ready (matched by 'crack') and doesn't trigger Cleaning.
const HAIR_REGEX = /\bhair\b/i;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Choose a bucket from free text using keyword substring matching.
 * Order of precedence (Q9):
 *   1. Exterior
 *   2. Make-Ready
 *   3. Cleaning (also \bhair\b regex)
 *   4. Default → make_ready
 *
 * @param {string} text - typically `${description} ${room} ${area}`
 * @returns {'cleaning'|'make_ready'|'exterior'}
 */
function keywordBucketFor(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return 'make_ready';

  for (const kw of EXTERIOR_KEYWORDS) {
    if (lower.includes(kw)) return 'exterior';
  }
  for (const kw of MAKE_READY_KEYWORDS) {
    if (lower.includes(kw)) return 'make_ready';
  }
  for (const kw of CLEANING_KEYWORDS) {
    if (lower.includes(kw)) return 'cleaning';
  }
  if (HAIR_REGEX.test(lower)) return 'cleaning';
  return 'make_ready';
}

/**
 * Normalize an AI-emitted groupKey: lowercase, whitespace runs → '-',
 * strip non-alphanumeric/hyphen characters. Empty input returns ''.
 *
 * @param {string} rawKey
 * @returns {string}
 */
function normalizeGroupKey(rawKey) {
  if (!rawKey) return '';
  return String(rawKey)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Default liability for an issue at emission time (Q7, Q14).
 *  - Comparison mode: isNewSinceMoveIn=true → tenant; false → owner.
 *  - Single-inspection mode: always 'unassigned' (no baseline → can't auto-assign).
 *  - Caller may also pass 'unassigned' explicitly when AI was unclear; that
 *    branch is handled in assembleV3Blob, not here.
 *
 * @param {boolean} isNewSinceMoveIn
 * @param {boolean} isComparisonMode
 * @returns {'tenant'|'owner'|'unassigned'}
 */
function defaultLiabilityFor(isNewSinceMoveIn, isComparisonMode) {
  if (!isComparisonMode) return 'unassigned';
  return isNewSinceMoveIn === true ? 'tenant' : 'owner';
}

/**
 * Coerce AI-emitted severity into the V3 enum. Logs a warning when the input
 * was unexpected so we can spot prompt drift in the field (Q8).
 *
 * @param {unknown} rawSeverity
 * @returns {'minor'|'moderate'|'major'}
 */
function coerceSeverity(rawSeverity) {
  const s = String(rawSeverity || '').toLowerCase().trim();
  if (s === 'minor' || s === 'moderate' || s === 'major') return s;
  if (s === 'low') return 'minor';
  if (s === 'medium' || s === 'med') return 'moderate';
  if (s === 'high' || s === 'severe' || s === 'critical') return 'major';
  console.warn('[ai-review] coerced unexpected severity:', rawSeverity);
  return 'moderate';
}

/**
 * Recompute totals on a V3IssuesBlob in place. Cheap; safer than carrying
 * stale counts after applyReviewerDecisions.
 *
 * @param {V3IssuesBlob} blob
 */
function recomputeTotals(blob) {
  let total = 0;
  let skipped = 0;
  let unreviewed = 0;
  const walk = (issue) => {
    total += 1;
    if (issue.isSkipped) skipped += 1;
    if (!issue.isSkipped && issue.liabilityDefaultedBy === 'auto') unreviewed += 1;
  };
  for (const bucketName of ['cleaning', 'make_ready', 'exterior']) {
    for (const group of blob.buckets[bucketName] || []) {
      for (const issue of group.issues || []) walk(issue);
    }
  }
  for (const issue of blob.manualIssues || []) walk(issue);
  blob.totalIssues = total;
  blob.totalSkipped = skipped;
  blob.totalUnreviewed = unreviewed;
}

// ============================================================================
// Main orchestration
// ============================================================================

/**
 * Assemble the AI's flat issues[] array into a fully-populated V3IssuesBlob.
 *
 * Steps per issue:
 *   1. Resolve bucket: AI's bucket if confidence ≥ threshold, else keyword fallback.
 *   2. Coerce severity to the enum.
 *   3. Auto-default liability via defaultLiabilityFor (with 'unassigned' override
 *      when AI itself signalled liability:'unassigned').
 *   4. Normalize groupKey, fall back to description-derived key when missing.
 *   5. Group by (bucket, normalizedGroupKey); assign a shared groupId per group.
 *   6. Compute totals.
 *
 * Throws on structural problems so the caller can soft-fall-back to V2.
 *
 * @param {RawAiIssue[]} rawAiIssues
 * @param {boolean} isComparisonMode
 * @param {number} threshold
 * @returns {V3IssuesBlob}
 */
function assembleV3Blob(rawAiIssues, isComparisonMode, threshold) {
  if (!Array.isArray(rawAiIssues)) {
    throw new Error('assembleV3Blob: expected an array of AI issues');
  }

  // First pass: build fully-populated V3Issues (without groupIds yet).
  const processed = rawAiIssues.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`assembleV3Blob: issue at index ${idx} is not an object`);
    }
    const description = String(raw.description || '').trim();
    if (!description) {
      throw new Error(`assembleV3Blob: issue at index ${idx} is missing description`);
    }

    const room = String(raw.room || 'Unknown').trim();
    const area = String(raw.area || '').trim();
    const severity = coerceSeverity(raw.severity);

    const pageReferences = Array.isArray(raw.pageReferences)
      ? raw.pageReferences.filter((n) => Number.isFinite(Number(n))).map(Number)
      : [];

    const isNewSinceMoveIn = raw.isNewSinceMoveIn === true;
    const moveInNote = raw.moveInNote ? String(raw.moveInNote) : undefined;

    // Bucket resolution (Q9)
    const aiBucket = String(raw.bucket || '').toLowerCase();
    const aiConfidenceRaw = Number(raw.bucketConfidence);
    const aiConfidence = Number.isFinite(aiConfidenceRaw)
      ? Math.max(0, Math.min(1, aiConfidenceRaw))
      : 0;
    const validBuckets = ['cleaning', 'make_ready', 'exterior'];
    const aiBucketIsValid = validBuckets.includes(aiBucket);

    let bucket;
    let bucketAssignedBy;
    if (aiBucketIsValid && aiConfidence >= threshold) {
      bucket = aiBucket;
      bucketAssignedBy = 'ai';
    } else {
      bucket = keywordBucketFor(`${description} ${room} ${area}`);
      bucketAssignedBy = 'deterministic-fallback';
    }

    // Liability (Q7, Q14). If AI itself emitted 'unassigned' on the issue,
    // honor that even in comparison mode (genuinely ambiguous case).
    let liability;
    if (raw.liability === 'unassigned') {
      liability = 'unassigned';
    } else {
      liability = defaultLiabilityFor(isNewSinceMoveIn, isComparisonMode);
    }

    // groupKey: normalize AI's, fall back to a description-derived slug.
    let groupKey = normalizeGroupKey(raw.groupKey);
    if (!groupKey) {
      groupKey = normalizeGroupKey(description.split(/[.,;:]/)[0].slice(0, 60))
        || `issue-${idx}`;
    }
    const groupLabel = String(raw.groupLabel || description.slice(0, 80)).trim();

    /** @type {V3Issue} */
    const issue = {
      id: crypto.randomUUID(),
      groupId: '', // filled below after grouping
      bucket,
      room,
      area,
      description,
      pageReferences,
      severity,
      isNewSinceMoveIn,
      bucketConfidence: aiConfidence,
      bucketAssignedBy,
      liability,
      liabilityDefaultedBy: 'auto',
      isSkipped: false,
      edits: [],
    };
    if (moveInNote) issue.moveInNote = moveInNote;

    return { issue, groupKey, groupLabel };
  });

  // Second pass: group by (bucket, groupKey). Each group gets one shared groupId.
  /** @type {Record<string, V3IssueGroup[]>} */
  const buckets = { cleaning: [], make_ready: [], exterior: [] };
  /** @type {Map<string, V3IssueGroup>} */
  const groupIndex = new Map();

  for (const { issue, groupKey, groupLabel } of processed) {
    const compositeKey = `${issue.bucket}::${groupKey}`;
    let group = groupIndex.get(compositeKey);
    if (!group) {
      group = {
        groupId: crypto.randomUUID(),
        groupKey,
        groupLabel,
        issues: [],
      };
      groupIndex.set(compositeKey, group);
      buckets[issue.bucket].push(group);
    }
    issue.groupId = group.groupId;
    group.issues.push(issue);
  }

  /** @type {V3IssuesBlob} */
  const blob = {
    buckets: {
      cleaning: buckets.cleaning,
      make_ready: buckets.make_ready,
      exterior: buckets.exterior,
    },
    manualIssues: [],
    totalIssues: 0,
    totalSkipped: 0,
    totalUnreviewed: 0,
  };
  recomputeTotals(blob);
  return blob;
}

/**
 * Flatten a V3IssuesBlob into a V2-shaped object for the existing renderer.
 * Each display row carries `_v3Id` so reviewer decisions can be back-mapped
 * to the underlying V3Issue at save time (Q10 Option A).
 *
 * Order: cleaning → make_ready → exterior → manualIssues, preserving
 * group order within each bucket.
 *
 * @param {V3IssuesBlob} v3Blob
 * @param {string} overall_condition
 * @param {string} summary
 * @param {boolean} isComparisonMode - omit in_move_in field when false
 * @returns {{overall_condition: string, summary: string, issues: Array<Object>}}
 */
function transformV3ToV2ForDisplay(v3Blob, overall_condition, summary, isComparisonMode) {
  const issues = [];
  const pushIssue = (v3issue) => {
    const section = v3issue.pageReferences && v3issue.pageReferences.length > 0
      ? `Page ${v3issue.pageReferences.join(', ')}`
      : '(see source report)';

    /** @type {Record<string, unknown>} */
    const display = {
      room: v3issue.room,
      area: v3issue.area,
      description: v3issue.description,
      severity: v3issue.severity,
      section,
      photo_reference: '',
      _v3Id: v3issue.id,
    };

    // Renderer semantics: in_move_in='no' renders "NEW — Not in move-in".
    // isNewSinceMoveIn=true → was NOT in move-in → 'no'. (Plan had this
    // reversed; renderer is authoritative.)
    if (isComparisonMode) {
      display.in_move_in = v3issue.isNewSinceMoveIn ? 'no' : 'yes';
      if (v3issue.moveInNote) display.move_in_note = v3issue.moveInNote;
    }
    issues.push(display);
  };

  for (const bucketName of ['cleaning', 'make_ready', 'exterior']) {
    for (const group of v3Blob.buckets[bucketName] || []) {
      for (const issue of group.issues || []) pushIssue(issue);
    }
  }
  for (const issue of v3Blob.manualIssues || []) pushIssue(issue);

  return {
    overall_condition: overall_condition || 'unknown',
    summary: summary || '',
    issues,
  };
}

/**
 * Bake reviewer decisions back into a V3IssuesBlob. The displayedIssues array
 * carries `_v3Id` on each row; we use that to find the matching V3Issue across
 * all buckets and manualIssues. Returns a deep clone with mutations applied
 * and totals recomputed.
 *
 * Decision mapping:
 *   'tenant'     → liability='tenant',     liabilityDefaultedBy='reviewer'
 *   'owner'      → liability='owner',      liabilityDefaultedBy='reviewer'
 *   'wear'       → liability='normal_wear', liabilityDefaultedBy='reviewer'
 *   'skip'       → isSkipped=true, skippedAt=now, skippedReason='human_review'
 *   'unreviewed' / null → unchanged
 *
 * @param {V3IssuesBlob} v3Blob
 * @param {Array<{decision?: string} | string | null>} reviewerDecisions
 *   Renderer-shaped: either an array of {decision} objects (current send-to-crm
 *   shape) OR a flat array of decision strings. Both are tolerated.
 * @param {Array<{_v3Id: string}>} displayedIssues
 * @returns {{blob: V3IssuesBlob, mappedCount: number, unmappedCount: number}}
 */
function applyReviewerDecisions(v3Blob, reviewerDecisions, displayedIssues) {
  /** @type {V3IssuesBlob} */
  const cloned = JSON.parse(JSON.stringify(v3Blob));

  // Build id → V3Issue index across the cloned blob.
  /** @type {Map<string, V3Issue>} */
  const byId = new Map();
  for (const bucketName of ['cleaning', 'make_ready', 'exterior']) {
    for (const group of cloned.buckets[bucketName] || []) {
      for (const issue of group.issues || []) byId.set(issue.id, issue);
    }
  }
  for (const issue of cloned.manualIssues || []) byId.set(issue.id, issue);

  let mappedCount = 0;
  let unmappedCount = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < displayedIssues.length; i += 1) {
    const display = displayedIssues[i];
    const v3Id = display && display._v3Id;
    if (!v3Id) continue;

    const decisionEntry = reviewerDecisions ? reviewerDecisions[i] : null;
    const decision = typeof decisionEntry === 'string'
      ? decisionEntry
      : (decisionEntry && decisionEntry.decision) || null;

    if (!decision || decision === 'unreviewed') continue;

    const target = byId.get(v3Id);
    if (!target) {
      unmappedCount += 1;
      continue;
    }

    switch (decision) {
      case 'tenant':
        target.liability = 'tenant';
        target.liabilityDefaultedBy = 'reviewer';
        mappedCount += 1;
        break;
      case 'owner':
        target.liability = 'owner';
        target.liabilityDefaultedBy = 'reviewer';
        mappedCount += 1;
        break;
      case 'wear':
        target.liability = 'normal_wear';
        target.liabilityDefaultedBy = 'reviewer';
        mappedCount += 1;
        break;
      case 'skip':
        target.isSkipped = true;
        target.skippedAt = now;
        target.skippedReason = 'human_review';
        mappedCount += 1;
        break;
      default:
        // Unknown decision string — leave issue unchanged.
        break;
    }
  }

  recomputeTotals(cloned);
  return { blob: cloned, mappedCount, unmappedCount };
}

module.exports = {
  // Pure helpers (exported for tests + reuse in main.js telemetry)
  keywordBucketFor,
  normalizeGroupKey,
  defaultLiabilityFor,
  coerceSeverity,
  recomputeTotals,
  // Orchestration
  assembleV3Blob,
  transformV3ToV2ForDisplay,
  applyReviewerDecisions,
  // Constants exposed for tests / debugging
  EXTERIOR_KEYWORDS,
  MAKE_READY_KEYWORDS,
  CLEANING_KEYWORDS,
};
