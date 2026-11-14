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
function fit(circles, xs, n, minY, maxY, minPitch, maxPitch) {
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
  // Allow one missing row, but penalize it heavily; estimate its positions
  // later so the UI can mark those inferred answers for manual review.
  let best = null;
  for (const start of rows)
    for (const next of rows) {
      const pitch = next.y - start.y;
      if (pitch < minPitch * S || pitch > maxPitch * S) continue;
      const chosen = [];
      let score = 0;
      for (let row = 0; row < n; row++) {
        const target = start.y + row * pitch;
        const match = rows.filter(r => Math.abs(r.y - target) < pitch * .23).sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target))[0];
        if (match) {
          chosen.push(match);
          score += match.count - Math.abs(match.y - target) / pitch
        } else {
          chosen.push(null);
          score -= 8
        }
      }
      if (chosen.filter(Boolean).length < n - 1) continue;
      if (!best || score > best.score) best = {
        rows: chosen,
        score,
        pitch,
        startY: start.y
      };
    }
  if (!best) return null;
  const radius = median(best.rows.filter(Boolean).flatMap(row => row.cols.filter(Boolean).map(p => p.r)));
  const centers = best.rows.map((row, i) => xs.map((x, col) => row?.cols[col] || {
    x: x * S,
    y: row?.y ?? best.startY + i * best.pitch,
    r: radius,
    inferred: true
  }));
  return {
    ...best,
    centers,
    radius,
    coverage: best.rows.reduce((s, r) => s + (r?.count || 0), 0) / (n * xs.length)
  };
}
// Main answers form 15 rows. Page 2 may also contain a separate five-row
// correction grid beneath them; do not let those rows change the main pitch.
export function fitMainGrid(h, components) {
  const circles = observedCircles(h, components),
    grid = fit(circles, [78.129, 121.285, 164.442, 207.599, 349.719, 392.875, 436.032, 479.189], 15, 80, 760, 20, 37);
  if (!grid || grid.coverage < .8) return null;
  grid.corrections = fit(circles, [156.257, 189.741, 223.225, 256.708, 424.127, 457.61, 491.094, 524.578], 5, (grid.rows.at(-1)?.y ?? grid.startY + 14 * grid.pitch) / S + 15, 790, 25, 60);
  return grid;
}
