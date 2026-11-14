// Rosters are imported on the device, never bundled into a public website.
// Account roles/statuses are not inferred or filtered by the recognizer.
const storageKey = 'paperscore-roll-roster';
let roster = [];
try {
  if (typeof localStorage !== 'undefined') roster = JSON.parse(localStorage.getItem(storageKey) || '[]');
} catch {}
const normalized = values => [...new Set(values.map(value => String(value).trim().toLowerCase()).filter(value => /^\d{2}[a-z]\d{4}$/.test(value) || /^\d{9}$/.test(value)))];
roster = normalized(Array.isArray(roster) ? roster : []);
export function getRollRoster() {
  return [...roster];
}
export function setRollRoster(values) {
  const next = normalized(values);
  if (!next.length) throw Error('No valid roll numbers were found in this roster.');
  roster = next;
  if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, JSON.stringify(roster));
  return roster.length;
}
