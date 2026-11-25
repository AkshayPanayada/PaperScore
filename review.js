// Shared by the app and evaluation: one policy prevents benchmark/UI drift.
// Retraining reduces uncertainty; confidence and geometry safeguards stay fixed.
import {
  classify,
  fillRatio,
  locateBubble
} from './reader.js?v=12';
const choices = ['A', 'B', 'C', 'D'];

// Mutate the shared page entries so confirmation survives uploading another
// page. Missing questions and separate correction/identity flags stay pending.
export function confirmAllAnswers(results) {
  for (const response of results)
    if (!response.missing) response.flag = false;
}

export function assessment(predictions, ink, inferred, keyAnswer = null) {
  const reasons = [];
  for (let option = 0; option < 4; option++) {
    const p = predictions[option];
    if (Math.max(p[1], p[2]) < .93) reasons.push('low-confidence');
    if (ink[option] > .1 && p[2] < .5) reasons.push('unexplained-ink');
    if (inferred[option]) reasons.push('inferred-position');
  }
  // Image certainty cannot resolve a multiple-mark response when the exam key
  // requires a single option. Preserve that separate reason for manual review.
  if (keyAnswer?.length === 1 && predictions.filter(p => p[2] > .5).length > 1) {
    reasons.push('multiple-options');
  }
  return [...new Set(reasons)];
}

export function readQuestion(h, image, page, question, keyAnswer = null) {
  const positions = choices.map((_, option) => locateBubble(h, page, question, option));
  const predictions = positions.map(p => classify(h, image, p.x, p.y, p.r));
  const vals = positions.map(p => fillRatio(h, image, p.x, p.y, p.r));
  const selected = choices.filter((_, option) => predictions[option][2] > .5).join('');
  const reasons = assessment(predictions, vals, positions.map(p => !!p.inferred), keyAnswer);
  return {
    selected,
    flag: reasons.length > 0,
    reasons,
    vals,
    predictions
  };
}
