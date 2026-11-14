import {
  classifyRectangle
} from './ml.js?v=11';
// Automatic registration with illumination-normalized components, ranked by the ML model.
export function analyzeImage(image) {
  const {
    width,
    height,
    data
  } = image, n = width * height, gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    gray[i] = (data[k] * 77 + data[k + 1] * 150 + data[k + 2] * 29) >> 8
  }
  // A summed-area table makes local mean brightness constant-time per pixel.
  const integral = new Float64Array((width + 1) * (height + 1)),
    stride = width + 1;
  for (let y = 1; y <= height; y++) {
    let sum = 0;
    for (let x = 1; x <= width; x++) {
      sum += gray[(y - 1) * width + x - 1];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + sum
    }
  }
  // Compare ink with nearby paper, accommodating broad lighting gradients.
  const radius = Math.round(Math.min(width, height) * .035),
    binary = new Uint8Array(n);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius),
        x1 = Math.min(width, x + radius),
        y0 = Math.max(0, y - radius),
        y1 = Math.min(height, y + radius);
      const mean = (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));
      const i = y * width + x;
      binary[i] = gray[i] < mean - 26 && gray[i] < 190 ? 1 : 0;
    }
  // Flood-fill four-connected dark pixels. Retain circle-like components for
  // grid fitting and rank sufficiently solid components as possible markers.
  const visited = new Uint8Array(n),
    queue = new Int32Array(n),
    candidates = [],
    components = [],
    scale = Math.min(width, height);
  for (let start = 0; start < n; start++) {
    if (visited[start] || !binary[start]) continue;
    let front = 0,
      back = 1,
      minX = width,
      maxX = 0,
      minY = height,
      maxY = 0,
      sumX = 0,
      sumY = 0;
    queue[0] = start;
    visited[start] = 1;
    while (front < back) {
      const i = queue[front++],
        x = i % width,
        y = (i / width) | 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      for (const next of [x ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y ? i - width : -1, y + 1 < height ? i + width : -1]) {
        if (next >= 0 && !visited[next] && binary[next]) {
          visited[next] = 1;
          queue[back++] = next
        }
      }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (w >= 5 && h >= 5 && w < scale * .12 && h < scale * .12) components.push({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      w,
      h,
      area: back
    });
    if (w > scale * .009 && h > scale * .009 && w < scale * .09 && h < scale * .09 && w / h > .38 && w / h < 2.65 && back / (w * h) > .57) {
      const p = {
        x: sumX / back,
        y: sumY / back,
        w,
        h,
        size: Math.sqrt(back)
      };
      p.confidence = classifyRectangle(image, p)[3];
      if (p.confidence > .35) candidates.push(p);
    }
  }
  return {
    candidates,
    components
  };
}
// Divide candidates into image quadrants, then score complete quadrilaterals
// by model confidence, page coverage and similarity of marker sizes.
export function detectMarkers(image, analysis = analyzeImage(image)) {
  const {
    width,
    height
  } = image, {
    candidates
  } = analysis;
  const groups = [
    [],
    [],
    [],
    []
  ];
  for (const p of candidates) {
    const q = (p.y < height / 2 ? 0 : 2) + (p.x < width / 2 ? 0 : 1);
    groups[q].push(p)
  }
  if (groups.some(g => !g.length)) throw Error('Could not find all four printed squares automatically. Include the full page and retake in even light.');
  groups.forEach((g, q) => g.sort((a, b) => {
    const dist = p => Math.hypot((p.x - (q % 2 ? width : 0)) / width, (p.y - (q < 2 ? 0 : height)) / height);
    return (b.confidence - .3 * dist(b)) - (a.confidence - .3 * dist(a));
  }).splice(3));
  // The clockwise order is top-left, top-right, bottom-right, bottom-left.
  let best = null;
  for (const a of groups[0])
    for (const b of groups[1])
      for (const c of groups[3])
        for (const d of groups[2]) {
          const pts = [a, b, c, d],
            sizes = pts.map(p => p.size),
            ratio = Math.max(...sizes) / Math.min(...sizes);
          if (ratio > 3.5) continue;
          const area = Math.abs(pts.reduce((s, p, i) => {
            const q = pts[(i + 1) % 4];
            return s + p.x * q.y - q.x * p.y
          }, 0)) / 2;
          if (area < width * height * .13) continue;
          const score = pts.reduce((s, p) => s + p.confidence, 0) + area / (width * height) - .2 * (ratio - 1);
          if (!best || score > best.score) best = {
            score,
            points: pts.map(p => [p.x, p.y])
          };
        }
  if (!best) throw Error('The four squares did not form a reliable page boundary. Retake the entire flat page.');
  return best.points;
}
