// Read all ten rows, including their handwritten-number areas. A number with
// no selected option is still evidence of a correction and must be reviewed.
import {
  locateCorrection,
  classify,
  fillRatio,
  projectedGray,
  SCALE
} from './reader.js?v=11';
import {
  rectifiedCrop
} from './question-preview.js?v=11';
import {
  prepareRollCrop
} from './roll-number.js?v=11';
import {
  createCorrectionSection
} from './corrections.js?v=11';

export function scanCorrections(h, image, source) {
  const rows = [];
  for (let col = 0; col < 2; col++)
    for (let row = 0; row < 5; row++) {
      const positions = [0, 1, 2, 3].map(a => locateCorrection(h, col, row, a));
      const first = positions[0],
        last = positions[3],
        radius = Math.max(...positions.map(p => p.r));
      const predictions = positions.map(p => classify(h, image, p.x, p.y, p.r));
      const ink = positions.map(p => fillRatio(h, image, p.x, p.y, p.r));
      const selected = ['A', 'B', 'C', 'D'].filter((_, a) => predictions[a][2] > .5).join('');
      // Row 10 has a two-digit printed row label, shifting its underline by one
      // glyph. Exclude the printed "Q no." text from handwriting evidence.
      const numberOffset = (String(col * 5 + row + 1).length - 1) * 6 * SCALE;
      const numberBounds = {
        left: first.x - 69 * SCALE + numberOffset,
        right: first.x - 28 * SCALE + numberOffset,
        top: first.y - 13 * SCALE,
        bottom: first.y + 9 * SCALE
      };
      const width = 164,
        height = 88,
        gray = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          gray[y * width + x] = projectedGray(h, image, numberBounds.left + (x + .5) * (numberBounds.right - numberBounds.left) / width,
            numberBounds.top + (y + .5) * (numberBounds.bottom - numberBounds.top) / height);
        }
      const numberCrop = prepareRollCrop(gray, width, height);
      const bounds = {
        left: first.x - 113 * SCALE,
        right: last.x + 1.5 * radius,
        top: first.y - 1.6 * radius,
        bottom: first.y + 1.6 * radius
      };
      const raster = rectifiedCrop(h, image, bounds, 650);
      const candidate = !!selected || !numberCrop.blank || ink.some(value => value > .09) || predictions.some(p => p[2] > .15);
      rows.push({
        row: col * 5 + row + 1,
        question: '',
        selected,
        detectedSelected: selected,
        candidate,
        status: candidate ? 'pending' : 'empty',
        source,
        predictions,
        ink,
        numberInk: !numberCrop.blank,
        numberCrop,
        raster,
        bounds
      });
    }
  const bounds = {
    left: Math.min(...rows.map(r => r.bounds.left)),
    right: Math.max(...rows.map(r => r.bounds.right)),
    top: Math.min(...rows.map(r => r.bounds.top)) - 15 * SCALE,
    bottom: Math.max(...rows.map(r => r.bounds.bottom)) + 6 * SCALE
  };
  const visible = [
    [bounds.left, bounds.top],
    [bounds.right, bounds.top],
    [bounds.right, bounds.bottom],
    [bounds.left, bounds.bottom]
  ].every(([x, y]) => {
    const z = h[6] * x + h[7] * y + 1,
      u = (h[0] * x + h[1] * y + h[2]) / z,
      v = (h[3] * x + h[4] * y + h[5]) / z;
    return u >= 0 && v >= 0 && u < image.width && v < image.height;
  });
  return {
    ...createCorrectionSection(),
    source,
    scanned: true,
    visible,
    reliable: !!h.grid?.corrections && h.grid.corrections.coverage >= .8,
    raster: rectifiedCrop(h, image, bounds, 1000),
    rows
  };
}
