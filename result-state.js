import {
  correctionIssues,
  createCorrectionSection
} from './corrections.js?v=11';
// Keep an incomplete scan distinct from a completed grade.
export function resultState({
  name = '',
  rollNumber = '',
  rollPending = false,
  count,
  key = [],
  pages = [],
  results = [],
  corrections = [],
  correctionSection = null,
  busy = false
}) {
  const received = new Set(pages),
    required = [1, 2]; // Page 2 contains corrections, even for short tests.
  const missingPages = required.filter(p => !received.has(p));
  // Missing questions already have a page blocker; do not also list every
  // absent answer as a manual-review blocker. A reviewed zero score is valid.
  const flagged = results.flatMap((r, i) => r.flag && !r.missing ? [i + 1] : []);
  const correctionState = correctionSection || createCorrectionSection();
  const issues = correctionIssues(correctionState, count);
  const pendingCorrections = new Set([...issues.pending, ...issues.invalid, ...issues.duplicates.flatMap(group => group.rows)]).size + corrections.filter(r => r.flag).length;
  const scanned = results.filter(r => !r.missing).length;
  const score = results.filter((r, i) => !r.missing && r.selected === key[i]).length;
  const blockers = [];
  if (busy) blockers.push('Wait for the page to finish reading.');
  const hasIdentity = !!(name.trim() || rollNumber.trim());
  if (!hasIdentity) blockers.push('Enter a student name or roll number.');
  if (rollPending) blockers.push('Confirm or correct the extracted roll number.');
  if (key.length !== count) blockers.push('Save a valid answer key.');
  if (missingPages.length) blockers.push('Upload ' + missingPages.map(p => 'Page ' + p).join(' and ') + '.');
  if (flagged.length) blockers.push('Confirm or correct ' + (flagged.length <= 8 ? flagged.map(q => 'Q' + q).join(', ') : flagged.length + ' flagged answers') + '.');
  if (pendingCorrections) blockers.push('Review ' + pendingCorrections + ' correction row' + (pendingCorrections === 1 ? '' : 's') + '.');
  if (issues.sectionPending && received.has(2)) blockers.push('Inspect and confirm the entire correction section on Page 2.');
  if (!scanned && !missingPages.length) blockers.push('Upload an answer page.');
  return {
    missingPages,
    flagged,
    pendingCorrections,
    correctionSectionPending: issues.sectionPending,
    scanned,
    score,
    blockers,
    canFinalize: blockers.length === 0,
    canSaveProgress: !busy && hasIdentity && key.length === count && scanned > 0
  };
}
