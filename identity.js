// Identity state is separate from answer recognition. OCR may suggest a roll
// number, but a manual correction always wins and blank pages cannot erase it.
export function createIdentity(saved = {}) {
  return {
    rollNumber: '',
    manual: false,
    pending: false,
    readings: {},
    message: '',
    candidates: [],
    ...saved
  };
}

export function editRollNumber(state, value) {
  return {
    ...state,
    rollNumber: value,
    manual: true,
    pending: false,
    candidates: [],
    message: 'Roll number entered manually.'
  };
}

export function confirmRollNumber(state) {
  return {
    ...state,
    manual: true,
    pending: false,
    candidates: [],
    message: 'Roll number confirmed.'
  };
}

export function mergeRollReading(state, page, reading) {
  const readings = {
    ...state.readings,
    [page]: reading
  };
  if (state.manual) return {
    ...state,
    readings
  };
  const found = Object.values(readings).filter(r => r.text);
  const unresolved = Object.values(readings).filter(r => !r.blank && r.needsReview && !r.text);
  if (!found.length) return {
    ...state,
    readings,
    rollNumber: '',
    pending: unresolved.length > 0,
    candidates: [...new Set(unresolved.flatMap(r => r.candidates || []))],
    message: unresolved.length ? 'Roll number is unclear. Choose a candidate or enter it manually.' : reading.blank ? 'No roll number found on this page.' : 'Could not read the roll number. Enter it manually.'
  };
  const rollNumber = found[0].text;
  const conflict = found.some(r => r.text !== rollNumber);
  const pending = conflict || unresolved.length > 0 || found.every(r => r.needsReview);
  return {
    ...state,
    readings,
    rollNumber,
    pending,
    candidates: pending ? [...new Set([...found, ...unresolved].flatMap(r => r.candidates || [r.text]))] : [],
    message: conflict ? 'Different roll numbers detected on the two pages. Check the number and confirm.' : pending ? 'Check the extracted roll number, then confirm or correct it.' : 'Roll number extracted automatically. You can edit it.'
  };
}

export function studentLabel(record) {
  return [record.name, record.rollNumber].filter(Boolean).join(' · ') || 'Student';
}
