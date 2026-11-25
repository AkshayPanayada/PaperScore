// Fit observed circle centres instead of assuming a printer preserved CSS row heights.
const S = 800 / 594.96;
const median = a => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)]
};
export function project(h, x, y) {
  const z = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z]
}

// Invert the homography so detected photo components can be compared with
// expected column positions in normalized page coordinates.
function inverse(h) {
  const [a, b, c, d, e, f, g, i] = h, j = 1;
  const m = [e * j - f * i, c * i - b * j, b * f - c * e, f * g - d * j, a * j - c * g, c * d - a * f, d * i - e * g, b * g - a * i, a * e - b * d];
  return m.slice(0, 8).map(v => v / m[8]);
}
// Filter component bounds by physical size and aspect ratio. Text, row
// rules and tiny specks should not be allowed to define the answer grid.
export function observedCircles(h, components) {
  const inv = inverse(h),
    out = [];
  for (const c of components) {
    const [x, y] = project(inv, c.x, c.y), left = project(inv, c.x - c.w / 2, c.y), right = project(inv, c.x + c.w / 2, c.y), top = project(inv, c.x, c.y - c.h / 2), bottom = project(inv, c.x, c.y + c.h / 2);
    const w = Math.hypot(right[0] - left[0], right[1] - left[1]),
      ht = Math.hypot(bottom[0] - top[0], bottom[1] - top[1]),
      r = (w + ht) / 4;
    if (r < 5.4 * S || r > 14 * S || w / ht < .65 || w / ht > 1.55 || c.area / (c.w * c.h) < .07) continue;
    out.push({
      x,
      y,
      r
    });
  }
  return out;
}

// Cluster nearby components into rows, then search for a regularly spaced
// lattice. A row needs at least five of eight option circles as evidence.
function fit(circles, xs, n, minY, maxY, minPitch, maxPitch, labelPoints = null) {
  const candidates = [];
  for (const p of circles) {
    if (p.y < minY * S || p.y > maxY * S) continue;
    let col = 0;
    for (let a = 1; a < xs.length; a++)
      if (Math.abs(p.x - xs[a] * S) < Math.abs(p.x - xs[col] * S)) col = a;
    if (Math.abs(p.x - xs[col] * S) > 12 * S) continue;
    candidates.push({
      ...p,
      col,
      error: Math.abs(p.x - xs[col] * S)
    });
  }
  const typicalRadius = median(candidates.map(p => p.r));
  // Ink blobs inside a ring are separate components; fit the ring, not the blob.
  const rings = candidates.filter(p => p.r > typicalRadius * .8 && p.r < typicalRadius * 1.3);
  rings.sort((a, b) => a.y - b.y);
  const groups = [];
  for (const p of rings) {
    let group = groups.find(g => Math.abs(g.y - p.y) < 4 * S);
    if (!group) {
      group = {
        y: p.y,
        points: []
      };
      groups.push(group)
    }
    group.points.push(p);
    group.y = median(group.points.map(v => v.y));
  }
  const rows = groups.map(g => {
    const cols = xs.map((_, col) => g.points.filter(p => p.col === col).sort((a, b) => a.error - b.error)[0]);
    return {
      y: median(cols.filter(Boolean).map(p => p.y)),
      cols,
      count: cols.filter(Boolean).length
    };
  }).filter(g => g.count >= 5).sort((a, b) => a.y - b.y);
  const matchLattice = (startY, pitch, tol = .23) => {
    const chosen = [];
    let score = 0;
    for (let row = 0; row < n; row++) {
      const target = startY + row * pitch;
      const match = rows.filter(r => Math.abs(r.y - target) < pitch * tol).sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target))[0];
      if (match) {
        chosen.push(match);
        score += match.count - Math.abs(match.y - target) / pitch;
      } else {
        chosen.push(null);
        score -= 8;
      }
    }
    return {
      chosen,
      score
    };
  };
  // Allow one missing row, but penalize it heavily; estimate its positions
  // later so the UI can mark those inferred answers for manual review.
  let best = null;
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const dy = rows[j].y - rows[i].y;
      const minStep = Math.max(1, Math.ceil(dy / (maxPitch * S)));
      const maxStep = Math.min(n - 1, Math.floor(dy / (minPitch * S)));
      for (let step = minStep; step <= maxStep; step++) {
        let pitch = dy / step,
          startY = rows[i].y;
        let {
          chosen,
          score
        } = matchLattice(startY, pitch, .23);
        if (chosen.filter(Boolean).length < n - 1) continue;
        // Refine startY and pitch across all matched rows so slight top/bottom curl
        // does not reject the first or last row.
        const pts = chosen.flatMap((r, idx) => r ? [[idx, r.y]] : []);
        const meanR = pts.reduce((s, [r]) => s + r, 0) / pts.length;
        const meanY = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
        const denom = pts.reduce((s, [r]) => s + (r - meanR) ** 2, 0);
        if (denom > 0) {
          const regPitch = pts.reduce((s, [r, y]) => s + (r - meanR) * (y - meanY), 0) / denom;
          if (regPitch >= minPitch * S && regPitch <= maxPitch * S) {
            pitch = regPitch;
            startY = meanY - pitch * meanR;
            ({
              chosen,
              score
            } = matchLattice(startY, pitch, .25));
            if (chosen.filter(Boolean).length < n - 1) continue;
          }
        }
        if (!best || score > best.score) best = {
          rows: chosen,
          score,
          pitch,
          startY
        };
      }
    }
  if (!best) return null;
  // If only n-1 rows matched and the missing slot was placed at the bottom,
  // check whether circles or question labels indicate the missing row is at the top.
  if (best.rows[0] && !best.rows[n - 1]) {
    const topY = best.startY - best.pitch,
      botY = best.startY + (n - 1) * best.pitch;
    if (topY >= minY * S) {
      const nearCircles = y => candidates.filter(p => Math.abs(p.y - y) < 4.5 * S).length;
      const nearLabels = y => {
        if (!labelPoints) return 0;
        const col0 = xs[0] * S,
          col4 = xs[4] * S;
        return labelPoints.filter(p => Math.abs(p.y - y) < .4 * best.pitch && ((p.x > col0 - 45 * S && p.x < col0 - 14 * S) || (p.x > col4 - 45 * S && p.x < col4 - 14 * S))).length;
      };
      if (nearCircles(topY) + 2 * nearLabels(topY) > nearCircles(botY) + 2 * nearLabels(botY)) {
        best.rows = [null, ...best.rows.slice(0, n - 1)];
        best.startY = topY;
      }
    }
  }
  const radius = median(best.rows.filter(Boolean).flatMap(row => row.cols.filter(Boolean).map(p => p.r)));
  const centers = best.rows.map((row, i) => {
    const targetY = row?.y ?? best.startY + i * best.pitch;
    return xs.map((x, col) => row?.cols[col] || {
      ...(candidates.filter(p => p.col === col && Math.abs(p.y - targetY) < 4.5 * S).sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY))[0] || {
        x: x * S,
        y: targetY,
        r: radius
      }),
      inferred: true
    });
  });
  return {
    ...best,
    centers,
    radius,
    coverage: best.rows.reduce((s, r) => s + (r?.count || 0), 0) / (n * xs.length)
  };
}
const DEFAULT_MAIN_XS = [78.129, 121.285, 164.442, 207.599, 349.719, 392.875, 436.032, 479.189];
const DEFAULT_CORR_XS = [156.257, 189.741, 223.225, 256.708, 424.127, 457.61, 491.094, 524.578];

// Infer two evenly spaced 4-column blocks when printed sheets use wider bubble spacing.
function inferColumns(circles, minY, maxY, minCount) {
  const inBand = circles.filter(p => p.y >= minY * S && p.y <= maxY * S);
  if (inBand.length < minCount * 4) return null;
  const typicalRadius = median(inBand.map(p => p.r));
  const rings = inBand.filter(p => p.r > typicalRadius * .78 && p.r < typicalRadius * 1.32);
  if (rings.length < minCount * 4) return null;
  const clusters = [];
  for (const p of [...rings].sort((a, b) => a.x - b.x)) {
    const last = clusters.at(-1);
    if (!last || p.x - last.x > 8 * S) clusters.push({
      pts: [p],
      x: p.x
    });
    else {
      last.pts.push(p);
      last.x = median(last.pts.map(q => q.x));
    }
  }
  const cols = clusters.filter(c => c.pts.length >= minCount).map(c => c.x / S);
  const quads = arr => {
    const out = [];
    for (let a = 0; a < arr.length; a++)
      for (let b = a + 1; b < arr.length; b++)
        for (let c = b + 1; c < arr.length; c++)
          for (let d = c + 1; d < arr.length; d++) {
            const q = [arr[a], arr[b], arr[c], arr[d]];
            const gaps = [q[1] - q[0], q[2] - q[1], q[3] - q[2]];
            const dx = (gaps[0] + gaps[1] + gaps[2]) / 3;
            if (dx < 25 || dx > 85) continue;
            if (Math.max(...gaps.map(g => Math.abs(g - dx))) > 8) continue;
            const err = gaps.reduce((s, g) => s + Math.abs(g - dx), 0);
            if (err < 12) out.push({
              xs: q,
              dx,
              err
            });
          }
    return out;
  };
  const left = quads(cols.filter(x => x < 297.5)),
    right = quads(cols.filter(x => x >= 297.5));
  let best = null,
    bestScore = Infinity;
  for (const l of left)
    for (const r of right) {
      const diff = Math.abs(l.dx - r.dx);
      if (diff > 6) continue;
      const score = l.err + r.err + 2 * diff;
      if (score < bestScore) {
        bestScore = score;
        best = [...l.xs, ...r.xs];
      }
    }
  return best;
}

// Question numbers sit to the left of each block; reject 180-degree flips on symmetric layouts.
function isUprightGrid(labelPoints, grid) {
  const col0 = grid.centers[0][0].x,
    col3 = grid.centers[0][3].x,
    col4 = grid.centers[0][4].x,
    col7 = grid.centers[0][7].x;
  const minY = grid.startY - .5 * grid.pitch,
    maxY = grid.startY + 14.5 * grid.pitch;
  let leftLabels = 0,
    rightLabels = 0;
  for (const {
      x,
      y
    }
    of labelPoints) {
    if (y < minY || y > maxY) continue;
    if ((x > col0 - 45 * S && x < col0 - 14 * S) || (x > col4 - 45 * S && x < col4 - 14 * S)) leftLabels++;
    if ((x > col3 + 14 * S && x < col3 + 45 * S) || (x > col7 + 14 * S && x < col7 + 45 * S)) rightLabels++;
  }
  return leftLabels + rightLabels < 5 || rightLabels <= leftLabels + 2;
}

// Main answers form 15 rows. Page 2 may also contain a separate five-row
// correction grid beneath them; do not let those rows change the main pitch.
export function fitMainGrid(h, components) {
  const circles = observedCircles(h, components);
  const inv = inverse(h),
    labelPoints = components.map(c => {
      const [x, y] = project(inv, c.x, c.y);
      return {
        x,
        y
      };
    });
  let grid = fit(circles, DEFAULT_MAIN_XS, 15, 80, 760, 20, 37, labelPoints);
  if (!grid || grid.coverage < .95) {
    for (const maxY of [500, 760]) {
      const xs = inferColumns(circles, 80, maxY, 7);
      if (!xs) continue;
      const candidate = fit(circles, xs, 15, 80, 760, 20, 37, labelPoints);
      if (candidate && candidate.coverage > (grid?.coverage || 0)) {
        grid = candidate;
        break;
      }
    }
  }
  if (!grid || grid.coverage < .8 || !isUprightGrid(labelPoints, grid)) return null;
  const corrMinY = (grid.rows.at(-1)?.y ?? grid.startY + 14 * grid.pitch) / S + 15;
  let corrections = fit(circles, DEFAULT_CORR_XS, 5, corrMinY, 790, 25, 60);
  if (!corrections || corrections.coverage < .95) {
    const corrXs = inferColumns(circles, corrMinY, 790, 3);
    if (corrXs) {
      const candidate = fit(circles, corrXs, 5, corrMinY, 790, 25, 60);
      if (candidate && candidate.coverage > (corrections?.coverage || 0)) corrections = candidate;
    }
  }
  grid.corrections = corrections;
  return grid;
}
