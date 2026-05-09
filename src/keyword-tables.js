/**
 * Mission 9 Phase B.1 — keyword tables for V4 deterministic fallback classifier.
 * Hand-mirrored from keepsimplecrm/src/lib/inspections/migrate-v3-to-v4.ts.
 * Source of truth lives in keepsimplecrm. Updates require manual sync.
 * Last sync: 2026-05-08 (Phase B.0 SHIPPED at keepsimplecrm 4160637).
 */

// ============================================================================
// Internal per-bucket regex constants
// ============================================================================
//
// Three regex categories per bucket:
//   - primary:   strong signals — single match is sufficient
//   - secondary: weak signals — corroborate with primary or by context (not
//                consumed by classifyIssueByKeywords; reserved for AI prompt
//                builder + Phase E migration)
//   - exclude:   guards against mis-routing when other-bucket vocabulary is
//                present
//
// Evaluation order: BUCKET_PRIORITY_ORDER. First positive primary match after
// exclude check wins.

// Bucket: cleaning (house cleaning ONLY — not carpet)
const CLEANING_PRIMARY =
  /\b(dust|dusty|dirt|dirty|soiled|grime|grimey|grimy|stain|stained|smudge|fingerprint|debris|crumbs|grease|greasy|soap scum|residue|buildup|filth|filthy|sticky|cobweb|cobwebs|pet hair|food residue|food stain|spilled|spill|discolor|discolored|wipe down|needs cleaning|requires cleaning|vacuum|mopping|scuff|scuffed|scuff marks)\b/i;
const CLEANING_SECONDARY =
  /\b(clean|cleaning|trash|items\s+left|left\s+behind|left\s+in\s+(the\s+)?unit|jar|liner|liners|tenant\s+left|boxes|furniture|belongings|stuff\s+left)\b/i;
const CLEANING_EXCLUDE =
  /\b(carpet|rug|roach|cockroach|spider|insect|bug|wasp|hornet|bee|ant|rodent|mouse|mice|rat|termite|infestation|bulb|broken|missing|hole|holes|crack|cracked|cracking|peeling|patch|patches|painting|nails)\b/i;

// Bucket: carpet (mixed — cleaning subsection + damage subsection)
const CARPET_PRIMARY = /\b(carpet|rug|carpets|rugs|carpeting|carpet\s+padding|throw\s+rug|area\s+rug)\b/i;
const CARPET_EXCLUDE = /\b(rug\s+doctor|carpet\s+sample)\b/i;

// Bucket: light_bulbs (single approval)
const LIGHT_BULBS_PRIMARY =
  /\b(bulb|bulbs|light\s+bulb|light\s+bulbs|lamp\s+out|light\s+out|lights\s+out|burnt\s+out|burned\s+out|burnout|burn\s+out|needs\s+(a\s+)?bulb|missing\s+bulb)\b/i;
// Tightened exclude — only specific repair-language patterns. The bare phrase
// "light fixture" (without "broken"/"damaged"/etc.) appears in real Electron
// area names (e.g., "Bedroom 2 Light Fixture/Fan" — Meadow Ln #44) so cannot
// be used as an exclusion guard. Requires verb co-occurrence to fire.
const LIGHT_BULBS_EXCLUDE =
  /\b(fixture\s+(broken|damaged|missing|cracked)|wiring\s+(issue|problem|loose)|electrical\s+(issue|problem|hazard|short)|outlet\s+(broken|damaged|missing|not\s+working)|switch\s+(broken|damaged|missing)|lamp\s+(broken|damaged|missing)|lampshade|lamp\s+shade|chandelier\s+(broken|damaged|missing)|fan\s+(broken|damaged|missing|inoperable))\b/i;

// Bucket: pest_control (single approval)
const PEST_CONTROL_PRIMARY =
  /\b(roach|roaches|cockroach|cockroaches|spider|spiders|insect|insects|bug|bugs|wasp|wasps|hornet|hornets|bee|bees|ant|ants|rodent|rodents|mouse|mice|rat|rats|termite|termites|infestation|pest|pests|pest\s+droppings|pest\s+damage|gnaw|gnawed|droppings|dead\s+roach|dead\s+roaches|dead\s+spider|dead\s+insect|dead\s+bug|baby\s+roach|live\s+roach|living\s+roach|bed\s+bug|bed\s+bugs|flea|fleas|fly\s+infestation|nest)\b/i;
const PEST_CONTROL_SECONDARY = /\b(filled\s+with\s+(bugs|insects|cobwebs))\b/i;
const PEST_CONTROL_EXCLUDE = /\b(rugbug|debugger)\b/i;

// Bucket: make_ready (per-item — interior repairs)
const MAKE_READY_PRIMARY =
  /\b(broken|break|cracked|crack|cracks|cracking|chipped|chip|hole|holes|damaged|damage|torn|tear|rip|ripped|missing|loose|inoperable|inoperative|inop|non-functional|needs\s+replacement|needs\s+to\s+be\s+replaced|replace|replacement|needs\s+repair|needs\s+repairing|repair|patch|patching|patches|needs\s+patching|paint|painting|needs\s+paint|needs\s+painting|touch\s+up|touch-up|scratched|scratch|scratches|gouged|gouge|dented|dent|dents|warped|warp|warping|sagging|sag|leaking|leak|leaks|dripping|drip|water\s+damage|water\s+stain|rot|rotting|rotten|rotted|bent|stripped|worn\s+out|wear\s+and\s+tear|faulty|malfunctioning|malfunction|short\s+circuit|electrical\s+issue|no\s+power|won't\s+latch|won't\s+close|won't\s+lock|won't\s+open|stuck|swollen|delaminated|delamination|peeling|peel|bubbling|gap|gaps|caulk|caulking|needs\s+caulking|recaulk|grout|regrout|needs\s+grout|seal|sealing|needs\s+sealing|hinge|hinges|hardware|fixture|fixtures|nail|nails|nail\s+hole|nail\s+holes|exposed\s+wire|drain\s+stopper|garbage\s+disposal|disposal|baseboard\s+loose|doorframe|door\s+frame|door\s+chipped|door\s+broken|door\s+scuffed|window\s+screen\s+torn|caulking\s+cracked|tile\s+cracked|peeling\s+vinyl|peeling\s+floor|exposed|cabinet\s+broken|drawer\s+broken|drawer\s+missing|knob\s+missing|handle\s+missing|toilet\s+paper\s+holder)\b/i;
const MAKE_READY_SECONDARY = /\b(deep\s+mold|mold\s+in\s+walls|black\s+mold)\b/i;
const MAKE_READY_EXCLUDE =
  /\b(carpet|rug|bulb|bulbs|light\s+bulb|roach|cockroach|spider|insect|bug|wasp|ant|rodent|mouse|rat|termite|cobweb|grass|lawn|mow|tree|bush|hedge|flower\s+bed|fence|gutter|exterior\s+(paint|trim|siding))\b/i;

// Bucket: exterior_make_ready (per-item — exterior repairs)
//
// Entry-door routing rule (Phase B.0 STOP GATE 1 refinement):
// Front entry doors, back entry doors, screen doors, storm doors, doorbells
// route to make_ready (interior infrastructure — humans enter the unit
// through them). Storage shed doors, garage doors, fence gates, and other
// exterior-only outbuilding doors stay in exterior_make_ready.
//
// Implementation: tighten primary to require strong outbuilding-door /
// exterior-structure signals only. Drop the previous "front yard / back
// yard / exterior" weak secondary entirely — that was the source of the
// over-routing that put doorbells (Meadow Ln #32) into exterior_make_ready
// despite being entryway infrastructure. Add a whole-string lookahead
// exclude branch that fires on entry-door words ONLY when no outbuilding
// signal also appears in the text — this preserves Meadow Ln #50 ("Storage
// door — broken ... back door/screen") routing to exterior_make_ready while
// blocking doorbell/front-door/back-door/screen-door from over-routing.
const EXTERIOR_MAKE_READY_PRIMARY =
  /\b(storage\s+door|fence|fences|fenced|gate|shed|garage\s+door|driveway|patio|porch|deck|siding|soffit|fascia|gutter|gutters|downspout|roof|rooftop|shingle|shingles|mailbox|sprinkler\s+head|hose\s+bib|spigot|water\s+spigot|a\/c\s+(unit|condenser)|ac\s+unit|condenser\s+unit|hvac\s+unit|trash\s+area|walkway|sidewalk|exterior\s+light|porch\s+light|flood\s+light|soffit\s+light|exterior\s+paint|exterior\s+trim|exterior\s+siding|weep\s+hole|brick\s+veneer|stucco|window\s+screen|exterior\s+outlet|exterior\s+wiring)\b/i;
// Two-branch exclude:
//   1. Lawn-care + bulb words that route elsewhere (always blocks).
//   2. Entry-door words — block ONLY when no outbuilding signal (storage|
//      garage|shed door, fence, gate) also appears in the text. The branch
//      is anchored at ^ and uses whole-string lookaheads so a description
//      mentioning both "storage door" and "back door" (real Meadow Ln #50
//      shape) preserves exterior_make_ready routing via primary.
const EXTERIOR_MAKE_READY_EXCLUDE =
  /(?:\b(?:grass|lawn|mow|tree|bush|hedge|shrub|flower\s+bed|flowerbed|mulch|garden|bulb)\b)|(?:^(?=.*\b(?:doorbell|front\s+entry|back\s+entry|entry\s+door|entryway\s+door|screen\s+door|storm\s+door|front\s+door|back\s+door)\b)(?!.*\b(?:storage|garage|shed)\s+door\b)(?!.*\b(?:fence|gate)\b))/i;

// Bucket: exterior_lawn_care (mixed — 5 single-approval subsections)
const LAWN_GRASS = /\b(grass|lawn|lawns|mow|mowing|mowed|cut\s+grass|trim\s+grass|edging|edge\s+lawn|weed|weeds|weed-eat|weeded|brown\s+grass|brown\s+patch|brown\s+spot|dead\s+grass|tall\s+grass|overgrown\s+lawn|yard\s+overgrown|yard\s+long)\b/i;
const LAWN_BUSHES =
  /\b(bush|bushes|hedge|hedges|shrub|shrubs|prune|pruning|prune\s+(bush|bushes|hedge|shrub)|trim\s+(bush|bushes|hedge|shrub)|overgrown\s+(bush|bushes|hedge|shrub)|dead\s+(bush|bushes|hedge|shrub))\b/i;
const LAWN_TREES =
  /\b(tree|trees|branch|branches|fallen\s+branch|fallen\s+tree|dead\s+tree|dead\s+branch|stump|stumps|prune\s+tree|trim\s+tree|tree\s+overhanging)\b/i;
const LAWN_FLOWERBEDS =
  /\b(flower\s+bed|flowerbed|flower\s+beds|flowerbeds|mulch|garden|gardening|planter|planters|flower\s+pot|flowerpot|neglected\s+(garden|bed))\b/i;
const LAWN_OTHER =
  /\b(sprinkler|sprinklers|rock\s+garden|decorative\s+rock|landscaping\s+rock|lawn\s+ornament|fountain|bird\s+bath|birdbath|lawn\s+furniture|patio\s+furniture\s+left)\b/i;
// Combined lawn primary: any lawn subsection match. Used by
// BUCKET_PRIMARY_REGEX_TABLE for top-level bucket dispatch. Subsection
// precedence handled by LAWN_SUBSECTION_REGEX (priority order:
// flowerbeds → trees → bushes → grass → other_lawn).
const LAWN_CARE_PRIMARY = new RegExp(
  `(?:${LAWN_GRASS.source})|(?:${LAWN_BUSHES.source})|(?:${LAWN_TREES.source})|(?:${LAWN_FLOWERBEDS.source})|(?:${LAWN_OTHER.source})`,
  'i',
);
// Lawn care exclude: when a "broken" repair signal accompanies a lawn term,
// the item is exterior_make_ready (e.g., sprinkler HEAD broken). Lawn_care
// should not fire when the description carries strong make_ready repair
// vocabulary that targets a built (mechanical) part rather than a growing
// element.
const LAWN_CARE_EXCLUDE =
  /\b(sprinkler\s+head|broken|inop|inoperable|missing|damaged|cracked|leaking)\b/i;

// Bucket: other (per-item — fallback catch-all)
// Has no positive primary signal — fires only when the priority chain falls
// through (or the description literally contains "miscellaneous" / "tbd").
const OTHER_PRIMARY =
  /\b(other|miscellaneous|misc|tbd|to\s+be\s+determined|unable\s+to\s+categorize|not\s+sure|unclear)\b/i;

// ============================================================================
// Public regex tables — exported for AI prompt builders + classifier reuse
// ============================================================================

const BUCKET_PRIMARY_REGEX_TABLE = {
  cleaning: CLEANING_PRIMARY,
  carpet: CARPET_PRIMARY,
  light_bulbs: LIGHT_BULBS_PRIMARY,
  pest_control: PEST_CONTROL_PRIMARY,
  make_ready: MAKE_READY_PRIMARY,
  exterior_make_ready: EXTERIOR_MAKE_READY_PRIMARY,
  exterior_lawn_care: LAWN_CARE_PRIMARY,
  other: OTHER_PRIMARY,
};

// Partial — only buckets with secondary signals appear. exterior_make_ready
// intentionally has NO secondary (entry-door routing rule).
const BUCKET_SECONDARY_REGEX_TABLE = {
  cleaning: CLEANING_SECONDARY,
  pest_control: PEST_CONTROL_SECONDARY,
  make_ready: MAKE_READY_SECONDARY,
};

// Partial — only buckets with exclude rules appear. 'other' has no exclude.
const BUCKET_EXCLUDE_REGEX_TABLE = {
  cleaning: CLEANING_EXCLUDE,
  carpet: CARPET_EXCLUDE,
  light_bulbs: LIGHT_BULBS_EXCLUDE,
  pest_control: PEST_CONTROL_EXCLUDE,
  make_ready: MAKE_READY_EXCLUDE,
  exterior_make_ready: EXTERIOR_MAKE_READY_EXCLUDE,
  exterior_lawn_care: LAWN_CARE_EXCLUDE,
};

// Carpet subsection regex. Damage match wins; otherwise cleaning (default).
const CARPET_SUBSECTION_REGEX = {
  damage: /\b(tear|torn|rip|ripped|hole|holes|burn|burns|burnt|cigarette\s+burn|iron\s+burn|missing|missing\s+patch|cut\s+out|frayed|fray|lifted|lifted\s+seam|seam\s+separation|separation|wax|melted|won't\s+shampoo|permanent\s+stain|permanent|replace|replacement|needs\s+replacing)\b/i,
  cleaning:
    /\b(stain|stained|dirty|dirt|soiled|soil|matted|matt|discolor|discolored|pet\s+hair|pet\s+odor|pet\s+urine|pet\s+smell|odor|smell|vacuum|shampoo|steam\s+clean|hair\s+throughout|hair\s+everywhere)\b/i,
};

// Lawn care subsection regex. Priority order applied by classifier:
// flowerbeds → trees → bushes → grass → other_lawn. First match wins.
// Specific subsection terms (flowerbeds/trees/bushes) win over the broader
// grass vocabulary, since 'weed' / 'overgrown' / 'trim' apply to multiple
// subsections but only fire grass when no specific subsection term matches.
// "Flower beds neglected with weeds" → flowerbeds (not grass).
const LAWN_SUBSECTION_REGEX = {
  grass: LAWN_GRASS,
  bushes: LAWN_BUSHES,
  trees: LAWN_TREES,
  flowerbeds: LAWN_FLOWERBEDS,
  other_lawn: LAWN_OTHER,
};

// Lawn subsection evaluation priority — first match wins. Exported separately
// from LAWN_SUBSECTION_REGEX so consumers iterate in the canonical order
// without relying on Object.keys() ordering of the regex table.
const LAWN_SUBSECTION_PRIORITY = [
  'flowerbeds',
  'trees',
  'bushes',
  'grass',
  'other_lawn',
];

// Patterns that indicate a finding should be split into multiple V4 issues.
// Used by AI prompt instructions to encourage splitting. The deterministic
// classifier flags matches as `lossy: true` in the migration log when it
// can't perform the split itself (Phase E case).
const MULTI_ISSUE_SPLIT_PATTERNS = [
  // Pattern 1: 3+ comma-separated phrases at the top level
  /,\s+[^,]{2,},\s+[^,]{2,}/i,
  // Pattern 2: explicit conjunctions linking distinct issue types
  /\b(and|plus|as\s+well\s+as|in\s+addition\s+to)\b.{2,}/i,
  // Pattern 3: "filled with X and Y" / "covered in X and Y" enumerations
  /\b(filled\s+with|covered\s+in|including)\s+\w+(\s+and\s+\w+)+/i,
];

// Bucket evaluation priority. First match wins for the deterministic
// classifier. Order rationale: more-specific buckets first (carpet/bulbs
// over generic cleaning); pest before cleaning (cobwebs+bugs); lawn before
// exterior make-ready (yard overgrown vs broken sprinkler); exterior before
// interior; `other` last — fires only when nothing matched. See Phase B.0
// doc §"Rule precedence".
const BUCKET_PRIORITY_ORDER = [
  'carpet',
  'light_bulbs',
  'pest_control',
  'exterior_lawn_care',
  'exterior_make_ready',
  'make_ready',
  'cleaning',
  'other',
];

// ============================================================================
// classifyIssueByKeywords — deterministic fallback classifier
// ============================================================================

/**
 * Classify an issue's text into a V4 bucket (and subsection where applicable).
 * Used by assembleV4Blob when AI bucketConfidence < 0.7 OR AI omits subsection
 * key on carpet / exterior_lawn_care issues.
 *
 * Algorithm:
 *   1. Lowercase the input.
 *   2. Iterate BUCKET_PRIORITY_ORDER.
 *   3. For each bucket: if its exclude regex matches, skip.
 *   4. Else if its primary regex matches, this is the bucket.
 *      - For carpet: damage subsection wins if CARPET_SUBSECTION_REGEX.damage
 *        matches; else default to cleaning.
 *      - For exterior_lawn_care: iterate LAWN_SUBSECTION_PRIORITY; first
 *        LAWN_SUBSECTION_REGEX[sub] match wins.
 *   5. Return the first match. If priority chain falls through, return null.
 *
 * @param {string} text - free text (typically groupLabel + description + room + area)
 * @returns {{bucket: string, subsection?: string} | null}
 */
function classifyIssueByKeywords(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return null;

  for (const bucket of BUCKET_PRIORITY_ORDER) {
    const exclude = BUCKET_EXCLUDE_REGEX_TABLE[bucket];
    if (exclude && exclude.test(lower)) continue;

    const primary = BUCKET_PRIMARY_REGEX_TABLE[bucket];
    if (!primary || !primary.test(lower)) continue;

    if (bucket === 'carpet') {
      if (CARPET_SUBSECTION_REGEX.damage.test(lower)) {
        return { bucket: 'carpet', subsection: 'damage' };
      }
      return { bucket: 'carpet', subsection: 'cleaning' };
    }

    if (bucket === 'exterior_lawn_care') {
      for (const sub of LAWN_SUBSECTION_PRIORITY) {
        if (LAWN_SUBSECTION_REGEX[sub].test(lower)) {
          return { bucket: 'exterior_lawn_care', subsection: sub };
        }
      }
      // LAWN_CARE_PRIMARY is the union of subsection regexes, so reaching
      // this point means a subsection regex must match. Defensive return.
      return { bucket: 'exterior_lawn_care' };
    }

    return { bucket };
  }

  return null;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  BUCKET_PRIMARY_REGEX_TABLE,
  BUCKET_SECONDARY_REGEX_TABLE,
  BUCKET_EXCLUDE_REGEX_TABLE,
  CARPET_SUBSECTION_REGEX,
  LAWN_SUBSECTION_REGEX,
  LAWN_SUBSECTION_PRIORITY,
  MULTI_ISSUE_SPLIT_PATTERNS,
  BUCKET_PRIORITY_ORDER,
  classifyIssueByKeywords,
};
