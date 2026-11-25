// Rectify only the roll-number entry field, using the page's existing marker
// homography. Coordinates are PDF points; names/subject fields stay outside it.
import {
  projectedGray,
  SCALE
} from './reader.js?v=12';
import {
  normalizeRoll,
  resolveRollReadings
} from './roll-format.js?v=12';
const fields = {
  1: {
    x: 95,
    y: 84,
    width: 134,
    height: 27
  },
  2: {
    x: 375,
    y: 59,
    width: 122,
    height: 27
  },
};

export function rollCrop(h, image, page) {
  const rect = fields[page];
  if (!rect) throw Error('Unknown answer-sheet page.');
  const scale = 4,
    width = Math.round(rect.width * scale),
    height = Math.round(rect.height * scale);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      gray[y * width + x] = projectedGray(h, image, (rect.x + (x + .5) / scale) * SCALE, (rect.y + (y + .5) / scale) * SCALE);
    }
  return {
    ...prepareRollCrop(gray, width, height),
    original: {
      pixels: gray,
      width,
      height
    }
  };
}

export function prepareRollCrop(gray, width, height) {
  const sorted = Array.from(gray).sort((a, b) => a - b),
    white = sorted[Math.floor(sorted.length * .9)];
  const pixels = Uint8Array.from(gray, v => Math.max(0, Math.min(255, 255 - (white - v) * 255 / Math.max(white, 80))));
  const ink = Uint8Array.from(pixels, v => Number(v < 160));
  // Erase long horizontal rules, not short hyphens in an identifier. Rule
  // detection uses contiguous runs so separate letters cannot resemble a line.
  const ruleRows = [];
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      run = ink[y * width + x] ? run + 1 : 0;
      if (run > width * .55) {
        ruleRows.push(y);
        break;
      }
    }
  }
  for (const row of ruleRows)
    for (let y = Math.max(0, row - 2); y <= Math.min(height - 1, row + 2); y++) {
      for (let x = 0; x < width; x++) {
        ink[y * width + x] = 0;
        pixels[y * width + x] = 255;
      }
    }
  // Reject dust and blank underlines before starting the OCR worker. Keep only
  // glyph-sized components; a blank field must never invent a roll number.
  const visited = new Uint8Array(ink.length),
    queue = new Int32Array(ink.length),
    components = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || visited[start]) continue;
    let front = 0,
      back = 1,
      x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0;
    queue[0] = start;
    visited[start] = 1;
    while (front < back) {
      const i = queue[front++],
        x = i % width,
        y = Math.floor(i / width);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const n of [x ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y ? i - width : -1, y + 1 < height ? i + width : -1]) {
        if (n >= 0 && ink[n] && !visited[n]) {
          visited[n] = 1;
          queue[back++] = n;
        }
      }
    }
    if (back >= 12 && y1 - y0 >= 7 && x1 - x0 < width * .6) components.push({
      x0,
      y0,
      x1,
      y1,
      area: back
    });
  }
  if (!components.length) return {
    blank: true,
    width,
    height,
    pixels
  };
  const box = {
    x0: Math.min(...components.map(c => c.x0)),
    x1: Math.max(...components.map(c => c.x1)),
    y0: Math.min(...components.map(c => c.y0)),
    y1: Math.max(...components.map(c => c.y1))
  };
  const padding = 16,
    w = box.x1 - box.x0 + 1 + padding * 2,
    h = box.y1 - box.y0 + 1 + padding * 2;
  const crop = new Uint8Array(w * h).fill(255),
    binary = new Uint8Array(w * h).fill(255);
  for (let y = box.y0; y <= box.y1; y++)
    for (let x = box.x0; x <= box.x1; x++) {
      const dest = (y - box.y0 + padding) * w + x - box.x0 + padding;
      crop[dest] = pixels[y * width + x];
      binary[dest] = ink[y * width + x] ? 0 : 255;
    }
  return {
    blank: false,
    width: w,
    height: h,
    pixels: crop,
    binary
  };
}

// Preserve leading zeroes and ambiguous O/0 or I/1; never guess substitutions.
export function cleanRollNumber(text) {
  return normalizeRoll(text);
}

export function chooseRollReading(readings) {
  return resolveRollReadings(readings);
}

let workerPromise;
async function getWorker() {
  if (!workerPromise) workerPromise = (async () => {
    const {
      default: Tesseract
    } = await import('./ocr-assets/tesseract.esm.min.js');
    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath: new URL('./ocr-assets/worker.min.js', import.meta.url).href,
      corePath: new URL('./ocr-assets/core', import.meta.url).href,
      langPath: new URL('./ocr-assets/lang', import.meta.url).href,
      workerBlobURL: false,
      cacheMethod: 'none',
    }, {
      load_system_dawg: '0',
      load_freq_dawg: '0',
      load_number_dawg: '0'
    });
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      user_defined_dpi: '300'
    });
    return worker;
  })().catch(error => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

function canvasFor(crop, pixels) {
  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext('2d'),
    data = ctx.createImageData(crop.width, crop.height);
  for (let i = 0; i < pixels.length; i++) {
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = pixels[i];
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

let handwritingWorker, jobId = 0;
const handwritingJobs = new Map();

function handwrittenReading(crop) {
  if (!handwritingWorker) {
    handwritingWorker = new Worker(new URL('./handwriting-worker.js?v=12', import.meta.url), {
      type: 'module'
    });
    handwritingWorker.onmessage = ({
      data
    }) => {
      const job = handwritingJobs.get(data.id);
      if (!job) return;
      handwritingJobs.delete(data.id);
      clearTimeout(job.timeout);
      if (data.error) job.reject(Error(data.error));
      else job.resolve(data.text);
    };
    handwritingWorker.onerror = () => {
      for (const job of handwritingJobs.values()) {
        clearTimeout(job.timeout);
        job.reject(Error('Handwriting reader unavailable.'));
      }
      handwritingJobs.clear();
      handwritingWorker.terminate();
      handwritingWorker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const timeout = setTimeout(() => {
      // Stop the worker so an unusually slow job cannot hold the upload UI.
      for (const job of handwritingJobs.values()) {
        clearTimeout(job.timeout);
        job.reject(Error('Handwriting reading timed out.'));
      }
      handwritingJobs.clear();
      handwritingWorker?.terminate();
      handwritingWorker = null;
    }, 90000);
    handwritingJobs.set(id, {
      resolve,
      reject,
      timeout
    });
    handwritingWorker.postMessage({
      id,
      width: crop.width,
      height: crop.height,
      pixels: crop.pixels
    });
  });
}

export function rollPreview(crop) {
  const source = crop.original || crop;
  return canvasFor(source, source.pixels).toDataURL('image/jpeg', .85);
}

export async function recognizeRollNumber(crop, onStatus = () => {}) {
  if (crop.blank) return {
    text: '',
    confidence: 0,
    needsReview: false,
    blank: true
  };
  const worker = await getWorker(),
    readings = [];
  for (const pixels of [crop.pixels, crop.binary]) {
    const {
      data
    } = await worker.recognize(canvasFor(crop, pixels));
    readings.push({
      text: data.text,
      confidence: data.confidence,
      engine: 'printed'
    });
  }
  const printed = chooseRollReading(readings);
  if (printed.text && !printed.needsReview) return {
    ...printed,
    blank: false,
    engine: 'printed'
  };
  try {
    onStatus('Reading handwritten roll number…');
    const text = await handwrittenReading(crop);
    // Generative handwriting OCR has no calibrated identity confidence. Show
    // its suggestion, but require confirmation rather than accepting a guess.
    if (text) return {
      ...resolveRollReadings([...readings, {
        text,
        confidence: 0,
        engine: 'handwriting'
      }]),
      blank: false,
      engine: 'handwriting'
    };
  } catch {
    // A handwriting-model failure must not prevent OMR grading or manual ID.
  }
  return {
    ...printed,
    needsReview: true,
    blank: false,
    engine: 'printed'
  };
}

// Target-question OCR is only a suggestion. The correction workflow still
// requires the reviewer to confirm the visible handwritten number and answer.
export async function recognizeQuestionNumber(crop, count) {
  if (crop.blank) return null;
  const text = String(await handwrittenReading(crop)).replace(/\s+/g, '');
  const number = Number(text);
  return /^\d{1,2}$/.test(text) && number >= 1 && number <= count ? number : null;
}
