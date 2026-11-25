// Keep previews tied to their own source page. Rectification makes a rotated
// or perspective photograph readable without mixing two question rows.
import {
  locateBubble,
  SCALE
} from './reader.js?v=11';

export function questionCrop(h, image, page, question, width = 560) {
  const positions = [0, 1, 2, 3].map(a => locateBubble(h, page, question, a));
  const radius = Math.max(...positions.map(p => p.r));
  const left = Math.min(...positions.map(p => p.x)) - Math.max(radius * 5.2, 56 * SCALE);
  const right = Math.max(...positions.map(p => p.x)) + radius * 1.4;
  const top = Math.min(...positions.map(p => p.y)) - radius * 1.3;
  const bottom = Math.max(...positions.map(p => p.y)) + radius * 1.3;
  return rectifiedCrop(h, image, {
    left,
    right,
    top,
    bottom
  }, width);
}

// Use the same rectification as question crops so a sideways phone photo and
// a PDF scan both produce upright, equally sized A4 previews.
export function pageRaster(h, image, width = 780) {
  return rectifiedCrop(h, image, {
    left: 0,
    right: 800,
    top: 0,
    bottom: 842 * SCALE
  }, width);
}

export function rectifiedCrop(h, image, {
  left,
  right,
  top,
  bottom
}, width) {
  const height = Math.max(1, Math.round(width * (bottom - top) / (right - left)));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = left + (x + .5) * (right - left) / width,
        py = top + (y + .5) * (bottom - top) / height;
      const z = h[6] * px + h[7] * py + 1;
      const u = Math.round((h[0] * px + h[1] * py + h[2]) / z),
        v = Math.round((h[3] * px + h[4] * py + h[5]) / z);
      const dest = (y * width + x) * 4;
      if (u < 0 || v < 0 || u >= image.width || v >= image.height) data.fill(255, dest, dest + 4);
      else {
        const source = (v * image.width + u) * 4;
        data[dest] = image.data[source];
        data[dest + 1] = image.data[source + 1];
        data[dest + 2] = image.data[source + 2];
        data[dest + 3] = 255;
      }
    }
  return {
    data,
    width,
    height
  };
}
