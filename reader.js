import {
  detectMarkers,
  analyzeImage
} from './alignment.js?v=11';
import {
  fitMainGrid
} from './grid.js?v=11';
import {
  classifyProjected
} from './ml.js?v=11';
// The PDF uses points; normalize its width to 800 units for geometry fitting.
// All template coordinates below come from the bundled printable PDF.
const SCALE = 800 / 594.96,
  W = 800,
  H = 842 * SCALE;
const corners = [
  [29.763, 29.928],
  [565.502, 29.928],
  [565.502, 811.958],
  [29.763, 811.958]
].map(p => p.map(v => v * SCALE));
const template = {
  1: {
    first: 1,
    y: 253.153,
    xs: [
      [78.129, 121.285, 164.442, 207.599],
      [349.719, 392.875, 436.032, 479.189]
    ]
  },
  2: {
    first: 31,
    y: 119.218,
    xs: [
      [78.129, 121.285, 164.442, 207.599],
      [349.719, 392.875, 436.032, 479.189]
    ]
  }
};

// Each page has two blocks of 15 rows, with four options in each row.
function xy(page, q, a) {
  const t = template[page],
    local = q - t.first,
    col = local < 15 ? 0 : 1,
    row = local % 15;
  return [t.xs[col][a] * SCALE, (t.y + row * 23.8108) * SCALE]
}

function correctionXY(col, row, a) {
  return [([156.257, 189.741, 223.225, 256.708, 424.127, 457.61, 491.094, 524.578][col * 4 + a]) * SCALE, (558.227 + row * 40.9245) * SCALE]
}

// Gaussian elimination with partial pivoting solves the eight unknowns of
// the projective transform. Degenerate marker positions must fail explicitly.
function solve(A, b) {
  for (let i = 0; i < b.length; i++) {
    let p = i;
    for (let j = i + 1; j < b.length; j++)
      if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    if (Math.abs(A[i][i]) < 1e-10) throw Error('Invalid corners');
    let d = A[i][i];
    for (let k = i; k < b.length; k++) A[i][k] /= d;
    b[i] /= d;
    for (let j = 0; j < b.length; j++)
      if (j !== i) {
        let f = A[j][i];
        for (let k = i; k < b.length; k++) A[j][k] -= f * A[i][k];
        b[j] -= f * b[i]
      }
  }
  return b
}

// Map the four template marker centres into the photographed page. The
// ninth homography coefficient is fixed at 1 to remove the scale ambiguity.
function homography(points) {
  let A = [],
    b = [];
  corners.forEach(([x, y], i) => {
    let [u, v] = points[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v)
  });
  return solve(A, b)
}

// Sample the original photo through the transform, without warping the
// entire page. Coordinates outside the photo are treated as white paper.
function projectedGray(h, image, x, y) {
  const {
    data,
    width,
    height
  } = image;
  const den = h[6] * x + h[7] * y + 1,
    u = Math.round((h[0] * x + h[1] * y + h[2]) / den),
    v = Math.round((h[3] * x + h[4] * y + h[5]) / den);
  if (u < 0 || v < 0 || u >= width || v >= height) return 255;
  const z = (v * width + u) * 4;
  return (data[z] * 77 + data[z + 1] * 150 + data[z + 2] * 29) >> 8;
}

// Preserve the training crop-to-radius ratio even when printed circles
// are larger than the PDF template. This is essential for phone photos.
function classify(h, image, x, y, radius = 7.44 * SCALE) {
  return classifyProjected((px, py) => projectedGray(h, image, px, py), x, y, radius * 11.4 / 7.44)
}
// Prefer measured circle centres; fall back to the template if a grid
// cannot be fitted. Inferred grid positions are flagged for review by app.js.
export function locateBubble(h, page, q, a) {
  const local = q - (page === 1 ? 1 : 31),
    col = local < 15 ? 0 : 1,
    row = local % 15;
  return h.grid?.centers[row]?.[col * 4 + a] || {
    x: xy(page, q, a)[0],
    y: xy(page, q, a)[1],
    r: 7.44 * SCALE
  };
}
export function sampleBubble(h, image, page, q, a) {
  const p = locateBubble(h, page, q, a);
  return classify(h, image, p.x, p.y, p.r)
}
export function locateCorrection(h, col, row, a) {
  const p = h.grid?.corrections?.centers[row]?.[col * 4 + a];
  return p || {
    x: correctionXY(col, row, a)[0],
    y: correctionXY(col, row, a)[1],
    r: 7.44 * SCALE
  }
}

function orientationScore(h, data, page) {
  let evidence = 0,
    n = 0;
  for (let q = template[page].first; q < template[page].first + 30; q += 3)
    for (let a = 0; a < 4; a++) {
      const p = classify(h, data, ...xy(page, q, a));
      evidence += p[1] + p[2];
      n++;
    }
  return evidence / n;
}

export {
  SCALE,
  corners,
  xy,
  correctionXY,
  homography,
  projectedGray,
  classify,
  orientationScore
};
// Try all four rotations of the marker quadrilateral. A valid circle grid
// and the probability of actual bubbles jointly identify page orientation.
export function detectPage(image, forcedPage = null) {
  const analysis = analyzeImage(image),
    found = detectMarkers(image, analysis),
    scores = [];
  for (let shift = 0; shift < 4; shift++) {
    const points = found.map((_, i) => found[(i + shift) % 4]),
      h = homography(points),
      grid = fitMainGrid(h, analysis.components);
    if (grid) {
      h.grid = grid;
      const page = forcedPage || (grid.startY / SCALE > 190 ? 1 : 2);
      let evidence = 0,
        n = 0;
      for (let row = 0; row < 15; row += 3)
        for (let col = 0; col < 8; col++) {
          const p = grid.centers[row][col],
            prediction = classify(h, image, p.x, p.y, p.r);
          evidence += prediction[1] + prediction[2];
          n++;
        }
      scores.push({
        points,
        h,
        page,
        score: .55 * grid.coverage + .45 * evidence / n,
        method: 'observed-grid'
      });
    } else {
      for (const page of forcedPage ? [forcedPage] : [1, 2]) scores.push({
        points,
        h,
        page,
        score: orientationScore(h, image, page) * .8,
        method: 'template'
      });
    }
  }
  // Require both enough evidence and a margin over the runner-up rotation.
  scores.sort((a, b) => b.score - a.score);
  if (scores[0].score < .55 || scores[0].score - scores[1].score < .04) throw Error(forcedPage ? `Could not align Page ${forcedPage} reliably. Include the full sheet with all four squares visible.` : 'The page is uncertain. Select Page 1 or Page 2 above, then press “Read as selected page”.');
  return scores[0];
}

// An independent faint-ink guard complements the neural model. Sample
// only the inner 60% of the radius so a blank printed rim cannot count as ink.
export function fillRatio(h, data, x, y, r = 7.44 * SCALE) {
  const background = [];
  for (let angle = 0; angle < 12; angle++) {
    const t = angle * Math.PI / 6;
    background.push(projectedGray(h, data, x + 2 * r * Math.cos(t), y + 2 * r * Math.sin(t)));
  }
  background.sort((a, b) => a - b);
  const white = background[9];
  let ink = 0,
    total = 0;
  for (let dx = -6; dx <= 6; dx += 2)
    for (let dy = -6; dy <= 6; dy += 2) {
      if (dx * dx + dy * dy > 36) continue;
      ink += projectedGray(h, data, x + dx * r / 10, y + dy * r / 10) < white - 42 ? 1 : 0;
      total++;
    }
  return ink / total;
}
