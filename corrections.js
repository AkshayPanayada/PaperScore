// Correction decisions are independent of the original page readings. Every
// view/export derives the effective answer from these records; applying or
// undoing a correction never destroys the original student response.
export function createCorrectionSection() {
  return {
    scanned: false,
    visible: false,
    reliable: false,
    verified: false,
    source: null,
    rows: [],
    preview: ''
  };
}

export function optionSet(value) {
  const text = String(value || '').toUpperCase().replace(/[+\s]/g, '');
  if (!/^[ABCD]+$/.test(text)) return '';
  return ['A', 'B', 'C', 'D'].filter(choice => text.includes(choice)).join('');
}

const active = row => row.status === 'pending' || row.status === 'confirmed';
const validQuestion = (q, count) => Number.isInteger(Number(q)) && Number(q) >= 1 && Number(q) <= count;

export function correctionIssues(section, count) {
  const pending = [],
    invalid = [],
    groups = new Map();
  // A blank-looking scan still has ten rows. Missing rows must never be
  // mistaken for an empty, fully reviewed correction section.
  const completeRows = section.rows.length === 10 && new Set(section.rows.map(row => row.row)).size === 10 && section.rows.every(row => Number.isInteger(row.row) && row.row >= 1 && row.row <= 10);
  for (const row of section.rows) {
    if (!['empty', 'pending', 'confirmed', 'ignored', 'superseded'].includes(row.status) || row.status === 'pending') pending.push(row.row);
    if (row.status === 'empty' && row.candidate) invalid.push(row.row);
    if (row.status === 'ignored' && (!row.reason?.trim() || row.reviewedSource !== section.source)) invalid.push(row.row);
    if (row.status === 'superseded' && !section.rows.some(replacement => replacement.row === row.supersededBy && replacement.status === 'confirmed' && replacement.confirmedSource === section.source && Number(replacement.question) === Number(row.question))) invalid.push(row.row);
    if (!active(row)) continue;
    if (validQuestion(row.question, count)) {
      const q = Number(row.question);
      groups.set(q, [...(groups.get(q) || []), row.row]);
    }
    if (row.status === 'confirmed' && (!section.source || !validQuestion(row.question, count) || !optionSet(row.selected) || row.confirmedSource !== section.source)) invalid.push(row.row);
  }
  const duplicates = Array.from(groups, ([question, rows]) => ({
    question,
    rows
  })).filter(group => group.rows.length > 1);
  return {
    pending,
    invalid,
    duplicates,
    sectionPending: !completeRows || !section.source || !section.scanned || !section.visible || !section.verified || section.verifiedSource !== section.source,
    canVerify: completeRows && !!section.source && section.scanned && section.visible && !pending.length && !invalid.length && !duplicates.length
  };
}

export function editCorrection(section, rowNumber, patch = {}) {
  const rows = section.rows.map(row => row.row === rowNumber ? {
    ...row,
    ...patch,
    candidate: true,
    status: 'pending',
    editVersion: (row.editVersion || 0) + 1,
    confirmedSource: null,
    confirmedAt: null,
    reason: ''
  } : row);
  if (!rows.some(row => row.row === rowNumber)) throw Error('Unknown correction row.');
  return {
    ...section,
    rows,
    verified: false
  };
}

export function confirmCorrection(section, rowNumber, question, selected, count, replace = false) {
  if (!section.scanned || !section.visible) throw Error('Upload a complete Page 2 before confirming corrections.');
  if (!validQuestion(question, count)) throw Error(`Enter a question number from 1 to ${count}.`);
  const answer = optionSet(selected);
  if (!answer) throw Error('Select the replacement answer shown on the paper.');
  const q = Number(question),
    other = section.rows.filter(row => row.row !== rowNumber && active(row) && Number(row.question) === q);
  // Paper order does not establish precedence. Replacing another row requires
  // the reviewer's separate, explicit choice, and leaves that row in the audit.
  if (other.length && !replace) throw Error(`Another correction targets Q${q}. Choose which row is authoritative.`);
  if (!section.rows.some(row => row.row === rowNumber)) throw Error('Unknown correction row.');
  const now = new Date().toISOString();
  const rows = section.rows.map(row => row.row === rowNumber ? {
      ...row,
      question: q,
      selected: answer,
      status: 'confirmed',
      confirmedSource: section.source,
      confirmedAt: now,
      reason: ''
    } :
    other.includes(row) && replace ? {
      ...row,
      status: 'superseded',
      reason: `Replaced explicitly by correction row ${rowNumber}`,
      supersededBy: rowNumber
    } : row);
  return {
    ...section,
    rows,
    verified: false
  };
}

export function ignoreCorrection(section, rowNumber, reason) {
  if (!reason?.trim()) throw Error('Choose a reason for marking this correction row unused.');
  return {
    ...section,
    verified: false,
    rows: section.rows.map(row => row.row === rowNumber ? {
      ...row,
      status: 'ignored',
      reason,
      reviewedSource: section.source,
      confirmedSource: null,
      confirmedAt: null
    } : row)
  };
}

export function verifyCorrectionSection(section, count) {
  if (!correctionIssues(section, count).canVerify) throw Error('Resolve all correction rows and include the entire correction section before confirming it.');
  return {
    ...section,
    verified: true,
    identityReviewRequired: false,
    verifiedSource: section.source,
    verifiedAt: new Date().toISOString()
  };
}

export function correctionOverrides(section, count) {
  // Approvals belong to one uploaded correction page. Conflicts and stale
  // approvals have no scoring effect while the reviewer resolves them.
  const conflicts = new Set(correctionIssues(section, count).duplicates.map(group => group.question));
  const overrides = new Map();
  for (const row of section.rows) {
    if (section.source && row.status === 'confirmed' && row.confirmedSource === section.source && validQuestion(row.question, count) && optionSet(row.selected) && !conflicts.has(Number(row.question))) {
      overrides.set(Number(row.question), row);
    }
  }
  return overrides;
}

export function effectiveResponses(pages, count, section) {
  const overrides = correctionOverrides(section, count);
  return Array.from({
    length: count
  }, (_, index) => {
    const original = pages.get(index < 30 ? 1 : 2)?.[index % 30] || {
      selected: '',
      flag: true,
      missing: true
    };
    const correction = overrides.get(index + 1);
    // Preserve `missing` from the original: a correction cannot manufacture
    // a received main page or bypass the missing-page completion requirement.
    return correction ? {
      ...original,
      originalSelected: original.selected,
      selected: optionSet(correction.selected),
      flag: false,
      answerSource: 'correction',
      correctionRow: correction.row,
      correctionPreview: correction.preview
    } : {
      ...original,
      answerSource: 'main'
    };
  });
}

export function correctionAudit(section, includeImages = false) {
  const {
    preview,
    rows,
    ...metadata
  } = section;
  return {
    ...metadata,
    ...(includeImages ? {
      preview
    } : {}),
    rows: rows.map(({
        preview,
        numberPreview,
        numberCrop,
        ...row
      }) =>
      ({
        ...row,
        ...(includeImages ? {
          preview,
          numberPreview
        } : {})
      }))
  };
}
