import {
  getRollRoster
} from './roll-roster.js?v=11';

// Keep IDs as strings, retaining all leading zeroes. Case is normalized only;
// visually similar characters are never silently rewritten into another ID.
export function normalizeRoll(value) {
  const text = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  return /^[a-z0-9/?-]{1,32}$/.test(text) ? text : '';
}
export function rollFormat(value) {
  const text = normalizeRoll(value);
  return /^\d{2}[a-z]\d{4}$/.test(text) ? 'year-letter-number' : /^\d{9}$/.test(text) ? 'numeric-nine' : null;
}
export const isRosterRoll = value => getRollRoster().includes(normalizeRoll(value));

function distance(left, right) {
  let previous = Array.from({
    length: right.length + 1
  }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++) next.push(Math.min(previous[j + 1] + 1, next[j] + 1, previous[j] + Number(left[i] !== right[j])));
    previous = next;
  }
  return previous[right.length];
}

export function rollCandidates(value) {
  const text = normalizeRoll(value);
  if (!text) return [];
  const ranked = getRollRoster().map(roll => ({
    roll,
    distance: distance(text, roll)
  })).filter(candidate => candidate.distance <= 1);
  if (!ranked.length) return [];
  const best = Math.min(...ranked.map(candidate => candidate.distance));
  return ranked.filter(candidate => candidate.distance === best).map(candidate => candidate.roll);
}

export function resolveRollReadings(readings) {
  const observations = readings.map(reading => ({
    ...reading,
    text: normalizeRoll(reading.text),
    confidence: Number(reading.confidence) || 0
  })).filter(reading => reading.text);
  if (!observations.length) return {
    text: '',
    confidence: 0,
    needsReview: false,
    candidates: [],
    rawReadings: []
  };
  const exact = observations.filter(reading => isRosterRoll(reading.text));
  const exactIds = [...new Set(exact.map(reading => reading.text))];
  if (exactIds.length > 1) return {
    text: '',
    confidence: 0,
    needsReview: true,
    candidates: exactIds,
    rawReadings: observations,
    match: 'conflicting'
  };
  if (exactIds.length === 1) {
    const text = exactIds[0];
    const printed = observations.filter(reading => reading.engine !== 'handwriting');
    const agreement = printed.length >= 2 && printed.every(reading => reading.text === text && reading.confidence >= 75);
    return {
      text,
      confidence: Math.max(...exact.map(reading => reading.confidence)),
      needsReview: !agreement,
      candidates: [text],
      rawReadings: observations,
      match: 'exact'
    };
  }
  // A well-formed but unlisted ID is shown for review. Never replace it with
  // a nearby roster member: consecutive suffixes identify different people.
  const formatted = observations.filter(reading => rollFormat(reading.text));
  if (formatted.length) {
    const ids = [...new Set(formatted.map(reading => reading.text))];
    return {
      text: ids.length === 1 ? ids[0] : '',
      confidence: 0,
      needsReview: true,
      candidates: [...new Set(formatted.flatMap(reading => rollCandidates(reading.text)))],
      rawReadings: observations,
      match: 'unlisted'
    };
  }
  const candidates = [...new Set(observations.flatMap(reading => rollCandidates(reading.text)))];
  return {
    text: candidates.length === 1 ? candidates[0] : '',
    confidence: 0,
    needsReview: true,
    candidates,
    rawReadings: observations,
    match: candidates.length === 1 ? 'suggested' : 'unreadable'
  };
}
