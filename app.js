import * as pdfjsLib from './paperscore-assets/pdf.mjs';
import {
  SCALE,
  corners,
  xy,
  correctionXY,
  homography,
  projectedGray,
  classify,
  detectPage,
  locateBubble,
  locateCorrection,
  fillRatio
} from './reader.js?v=11';
import {
  loadModel
} from './ml.js?v=11';
import {
  resultState
} from './result-state.js?v=11';
import {
  readQuestion,
  confirmAllAnswers
} from './review.js?v=11';
import {
  questionCrop,
  pageRaster
} from './question-preview.js?v=11';
import {
  rollCrop,
  rollPreview,
  recognizeRollNumber
} from './roll-number.js?v=11';
import {
  createIdentity,
  editRollNumber,
  confirmRollNumber,
  mergeRollReading,
  studentLabel
} from './identity.js?v=11';
import {
  createCorrectionSection,
  editCorrection,
  effectiveResponses,
  correctionAudit
} from './corrections.js?v=11';
import {
  scanCorrections
} from './correction-reader.js?v=11';
import {
  renderCorrectionPanel
} from './correction-ui.js?v=11';
import {
  getRollRoster,
  setRollRoster
} from './roll-roster.js?v=11';
import {
  resolveRollReadings
} from './roll-format.js?v=11';

const $ = s => document.querySelector(s),
  choices = ['A', 'B', 'C', 'D'];
// Keep each uploaded page separate so either page can arrive first.
// Results combine those page entries; absent pages remain explicitly missing.
let image = null,
  points = [],
  key = [],
  results = [],
  pdfDoc = null,
  pdfPage = 1,
  savedThisSheet = false,
  count = 60;
let pages = new Map(),
  lastTemplate = null,
  correctionSection = createCorrectionSection();
// Store a separate upright preview for each answer page. The active working
// canvas can change without replacing either displayed page.
const pagePreviews = new Map();
let activeResultId = null;
let identity = createIdentity(),
  identityEpoch = 0;
let currentAlignment = null,
  currentFileFingerprint = '';
let pageSources = new Map(),
  pdfAssignments = new Map(),
  uploadSeq = 0,
  currentSource = '',
  busy = false;
// One CNN is used for all answer, marker and correction-bubble decisions.
const modelVariant = 'augmented';
const modelReady = loadModel(null, modelVariant).then(() => {
  $('#modelstatus').textContent = `${modelVariant === 'augmented' ? 'Augmented CNN' : modelVariant.toUpperCase()} reader ready.`
}).catch(err => {
  $('#modelstatus').textContent = err.message;
  throw err
});
pdfjsLib.GlobalWorkerOptions.workerSrc = 'paperscore-assets/pdf.worker.mjs';

function renderRosterStatus() {
  const count = getRollRoster().length;
  $('#rosterStatus').textContent = count ? `${count} roll numbers loaded locally. TA/inactive entries are included; account status is not inferred.` :
    'Load the roster CSV on this device to improve roll-number matching. It is not uploaded to the website.';
}
$('#rollRoster').onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const rows = (await file.text()).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.split(',')[0].trim().replace(/^"|"$/g, ''));
    setRollRoster(rows);
    renderRosterStatus();
    if (!identity.manual) {
      const previous = identity.readings;
      identity = createIdentity({
        ...identity,
        readings: {}
      });
      for (const [page, reading] of Object.entries(previous)) identity = mergeRollReading(identity, page,
        reading.blank ? reading : {
          ...reading,
          ...resolveRollReadings(reading.rawReadings || [{
            text: reading.text,
            confidence: reading.confidence,
            engine: reading.engine
          }])
        });
      renderIdentity();
    }
  } catch (error) {
    $('#rosterStatus').textContent = error.message;
  }
};
renderRosterStatus();

// Canonical option order makes A+C and C+A equivalent exact answer sets.
function parseKey() {
  const raw = $('#key').value.toUpperCase().trim().replace(/\s*\+\s*/g, '+');
  let entries = raw.split(/[\s,;]+/).filter(Boolean);
  if (count > 1 && entries.length === 1 && /^[ABCD]+$/.test(raw) && raw.length === count) {
    entries = raw.split('');
  }
  if (entries.length !== count) return null;
  const parsed = entries.map(entry => {
    if (!/^[ABCD](?:\+?[ABCD]){0,3}$/.test(entry)) return null;
    const options = entry.replaceAll('+', '');
    if (new Set(options).size !== options.length) return null;
    return choices.filter(choice => options.includes(choice)).join('');
  });
  return parsed.includes(null) ? null : parsed;
}

function setKey() {
  let k = parseKey();
  if (!k) {
    $('#keystatus').textContent = `Enter exactly ${count} entries. Use A, B, C or D, or combine options like A+C.`;
    $('#keystatus').className = 'error';
    return
  }
  key = k;
  localStorage.setItem('paperscore-key', JSON.stringify(key));
  localStorage.setItem('paperscore-count', String(count));
  $('#keystatus').textContent = `${count} answers saved`;
  $('#keystatus').className = 'success';
  if (results.length) render()
}
$('#keyCsv').onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const rows = (await file.text()).replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(',').map(cell => cell.trim().replace(/^"|"$/g, '')));
    if (rows[0][0]?.toLowerCase() !== 'question' || rows[0][1]?.toLowerCase() !== 'answer') throw Error('CSV header must be question,answer.');
    const entries = rows.slice(1).filter(row => row.some(Boolean)),
      n = entries.length;
    if (n < 1 || n > 60 || new Set(entries.map(row => Number(row[0]))).size !== n) throw Error('Include each question once, from 1 through 60.');
    const answers = Array(n);
    for (const [number, answer] of entries) {
      const q = Number(number);
      if (!Number.isInteger(q) || q < 1 || q > n) throw Error('Question numbers must be consecutive from 1.');
      answers[q - 1] = answer.toUpperCase()
    }
    count = n;
    $('#count').value = n;
    $('#key').value = answers.join(' ');
    if (!parseKey()) throw Error('Use A–D, or multiple options such as A+C, in every answer row.');
    activeResultId = null;
    clearPages();
    $('#result').hidden = true;
    setKey();
    $('#keystatus').textContent = `${n} answers loaded from ${file.name}`;
  } catch (err) {
    $('#keystatus').textContent = err.message;
    $('#keystatus').className = 'error'
  }
};
$('#savekey').onclick = setKey;
try {
  key = JSON.parse(localStorage.getItem('paperscore-key') || '[]');
  count = Number(localStorage.getItem('paperscore-count')) || 60;
  if (!Number.isInteger(count) || count < 1 || count > 60) count = 60;
  $('#count').value = count;
  if (key.length === count) {
    $('#key').value = key.map(answer => answer.split('').join('+')).join(' ');
    $('#keystatus').textContent = `${count} answers saved`;
    $('#keystatus').className = 'success'
  }
} catch {};
$('#count').onchange = () => {
  let n = Number($('#count').value);
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    $('#count').value = count;
    alert('Choose a whole number from 1 to 60.');
    return
  }
  count = n;
  key = [];
  activeResultId = null;
  clearPages();
  $('#result').hidden = true;
  $('#keystatus').textContent = 'Save an answer key for this question count';
  $('#keystatus').className = 'muted'
};
let cv = $('#photo'),
  ctx = cv.getContext('2d', {
    willReadFrequently: true
  });

function draw() {
  if (!image) {
    drawPagePreviews();
    return;
  }
  cv.width = image.width;
  cv.height = image.height;
  ctx.drawImage(image, 0, 0);
  const r = Math.max(7, cv.width / 150);
  points.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = '#f9b922';
    ctx.fill();
    ctx.fillStyle = '#172d42';
    ctx.font = `bold ${r*1.4}px sans-serif`;
    ctx.fillText(i + 1, x + r, y - r)
  });
  if (points.length === 4 && currentAlignment?.source === currentSource) {
    const {
      h,
      page
    } = currentAlignment, start = page === 1 ? 1 : 31;
    const project = (x, y) => {
      const z = h[6] * x + h[7] * y + 1;
      return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z]
    };
    for (let q = start; q < start + 30; q++)
      for (let a = 0; a < 4; a++) {
        const p = locateBubble(h, page, q, a),
          [x, y] = project(p.x, p.y),
          [rx, ry] = project(p.x + p.r, p.y),
          radius = Math.hypot(rx - x, ry - y);
        const selected = results[q - 1]?.selected?.includes(choices[a]);
        ctx.beginPath();
        ctx.arc(x, y, radius + 2, 0, 2 * Math.PI);
        ctx.strokeStyle = selected ? '#04965b' : '#1483ba';
        ctx.lineWidth = Math.max(1, cv.width / 800);
        ctx.stroke();
      }
  }
  $('#reset').disabled = false;
  drawPagePreviews();
}

function storePagePreview(page, h, data) {
  const raster = pageRaster(h, data),
    base = document.createElement('canvas');
  base.width = raster.width;
  base.height = raster.height;
  base.getContext('2d').putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
  const first = page === 1 ? 1 : 31,
    circles = [];
  for (let q = first; q < first + 30; q++)
    for (let a = 0; a < 4; a++) {
      circles.push({
        q,
        a,
        ...locateBubble(h, page, q, a)
      });
    }
  pagePreviews.set(page, {
    base,
    circles
  });
}

function drawPagePreviews() {
  $('#pagePreviews').hidden = pagePreviews.size === 0;
  for (const page of [1, 2]) {
    const entry = pagePreviews.get(page),
      canvas = $('#pagePreview' + page),
      empty = $('#pageEmpty' + page);
    const ready = !!entry?.base?.width;
    canvas.hidden = !ready;
    empty.hidden = ready;
    if (!ready) {
      canvas.width = 0;
      canvas.height = 0;
      continue;
    }
    canvas.width = entry.base.width;
    canvas.height = entry.base.height;
    const context = canvas.getContext('2d'),
      factor = canvas.width / 800,
      first = page === 1 ? 1 : 31;
    context.drawImage(entry.base, 0, 0);
    for (const p of entry.circles) {
      const selected = results[p.q - 1]?.selected?.includes(choices[p.a]);
      context.beginPath();
      context.arc(p.x * factor, p.y * factor, p.r * factor + 1, 0, 2 * Math.PI);
      context.strokeStyle = selected ? '#04965b' : '#1483ba';
      context.lineWidth = 1.2;
      context.stroke();
    }
  }
}

// Cap photo size to bound preprocessing time and memory use on phones.
function scaledImage(source) {
  const c = document.createElement('canvas'),
    factor = Math.min(1, 1900 / Math.max(source.width, source.height));
  c.width = Math.round(source.width * factor);
  c.height = Math.round(source.height * factor);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

function selectedPage() {
  return $('#pageChoice').value === 'auto' ? null : Number($('#pageChoice').value)
}

function updateSlots() {
  for (let p = 1; p <= 2; p++) {
    const el = $('#slot' + p);
    el.textContent = `Page ${p} · ${pages.has(p)?'read ✓':'missing'}`;
    el.classList.toggle('ready', pages.has(p));
  }
}

function clearPages() {
  currentAlignment = null;
  pages.clear();
  pagePreviews.clear();
  pageSources.clear();
  pdfAssignments.clear();
  correctionSection = createCorrectionSection();
  results = [];
  $('#result').hidden = true;
  updateSlots();
  drawPagePreviews();
}

function startCombinedPages() {
  clearPages();
  if (!identity.manual) {
    identityEpoch++;
    identity = createIdentity();
    renderIdentity();
  }
}

function renderIdentity() {
  $('#rollNumber').value = identity.rollNumber;
  $('#rollStatus').textContent = identity.message || 'Roll numbers are read on this device. Enter a name or roll number to save.';
  $('#rollStatus').className = identity.pending ? 'note statusline' : 'muted statusline';
  $('#confirmRoll').hidden = !identity.pending;
  $('#confirmRoll').disabled = !identity.rollNumber.trim();
  const suggestions = $('#rollSuggestions');
  suggestions.replaceChildren();
  for (const candidate of identity.pending ? identity.candidates || [] : []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = `Use ${candidate}`;
    button.onclick = () => {
      identity = editRollNumber(identity, candidate);
      savedThisSheet = false;
      renderIdentity();
    };
    suggestions.append(button);
  }
  $('#rollPreview').hidden = !identity.preview;
  if (identity.preview) $('#rollPreview').src = identity.preview;
  if (results.length) updateScore();
}
$('#rollNumber').addEventListener('input', () => {
  identity = editRollNumber(identity, $('#rollNumber').value);
  savedThisSheet = false;
  renderIdentity();
});
$('#confirmRoll').onclick = () => {
  identity = confirmRollNumber(identity);
  savedThisSheet = false;
  renderIdentity();
};

async function readRollFromPage(data, detection) {
  const epoch = identityEpoch;
  try {
    const crop = rollCrop(detection.h, data, detection.page);
    if (identity.manual && identity.rollNumber.trim()) {
      if (!crop.blank) identity.preview = rollPreview(crop);
      renderIdentity();
      return;
    }
    $('#rollStatus').textContent = crop.blank ? 'No roll number found on this page.' : 'Reading roll number…';
    const reading = await recognizeRollNumber(crop, status => {
      if (epoch === identityEpoch) $('#rollStatus').textContent = status;
    });
    // Reset/resume/next-student invalidates old OCR work. Manual edits made
    // while the worker runs are preserved by mergeRollReading().
    if (epoch !== identityEpoch) return;
    identity = mergeRollReading(identity, detection.page, reading);
    if (!crop.blank) identity.preview = rollPreview(crop);
    savedThisSheet = false;
    renderIdentity();
  } catch {
    if (epoch !== identityEpoch) return;
    identity = mergeRollReading(identity, detection.page, {
      text: '',
      blank: false
    });
    identity.message = 'Roll-number recognition is unavailable. Enter it manually; answer reading still works.';
    renderIdentity();
  }
}

function openForPage(page) {
  $('#pageChoice').value = String(page);
  $('#file').value = '';
  $('#file').click()
}
$('#uploadP1').onclick = () => openForPage(1);
$('#uploadP2').onclick = () => openForPage(2);
$('#uploadPhotos').onclick = () => openForPage('auto');
$('#uploadPdf').onclick = () => openForPage('auto');
$('#reassign').onclick = async () => {
  if (image) await autoRead(selectedPage())
};
async function showPdfPage(read = true) {
  try {
    const pg = await pdfDoc.getPage(pdfPage),
      base = pg.getViewport({
        scale: 1
      });
    const viewport = pg.getViewport({
      scale: Math.min(3, 1900 / Math.max(base.width, base.height))
    });
    const c = document.createElement('canvas');
    c.width = Math.ceil(viewport.width);
    c.height = Math.ceil(viewport.height);
    await pg.render({
      canvasContext: c.getContext('2d'),
      viewport
    }).promise;
    image = c;
    currentSource = `${currentFileFingerprint}:pdf${pdfPage}`;
    points = [];
    draw();
    $('#reassign').disabled = false;
    $('#pagestatus').textContent = `PDF page ${pdfPage} of ${pdfDoc.numPages}`;
    $('#prevpage').disabled = pdfPage <= 1;
    $('#nextpage').disabled = pdfPage >= pdfDoc.numPages;
    if (read) return await autoRead(pdfDoc.numPages === 1 ? selectedPage() : null);
    $('#pageChoice').value = String(pdfAssignments.get(pdfPage) || 'auto');
    $('#pointstatus').textContent = `Viewing PDF page ${pdfPage}. Choose its answer page above if you need to change the assignment.`;
    return true;
  } catch (err) {
    $('#pointstatus').textContent = err.message || 'Could not render this PDF page.';
    return false
  }
}
$('#prevpage').onclick = () => {
  if (!busy && pdfPage > 1) {
    pdfPage--;
    showPdfPage(false)
  }
};
$('#nextpage').onclick = () => {
  if (!busy && pdfDoc && pdfPage < pdfDoc.numPages) {
    pdfPage++;
    showPdfPage(false)
  }
};
$('#camera').onchange = e => {
  if (e.target.files.length) openFiles(Array.from(e.target.files))
};
$('#file').onchange = e => {
  if (e.target.files.length) openFiles(Array.from(e.target.files))
};

const isPdf = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
async function openFiles(files) {
  if (busy || !files.length) return;
  if (files.length > 2 || (files.length > 1 && files.some(isPdf))) {
    $('#pointstatus').textContent = 'Choose up to two photos, or one PDF, for a single student.';
    return;
  }
  busy = true;
  setUploadBusy(true);
  const batch = files.length === 2,
    seenPages = batch ? new Set() : null,
    errors = [];
  try {
    if (batch) startCombinedPages();
    for (const file of files) {
      // File order and names do not determine the answer page. Passing null
      // keeps both files in automatic mode even after Page 1 updates the UI.
      if (!await openFile(file, batch ? null : undefined, seenPages)) {
        errors.push(`${file.name}: ${$('#pointstatus').textContent}`);
      }
    }
    if (batch) $('#pointstatus').textContent = errors.length ? errors.join(' ') :
      'Both photos read. Page 1 and Page 2 previews are shown below the review section.';
  } finally {
    busy = false;
    setUploadBusy(false);
  }
}
// Read one student at a time. Source IDs prevent page reassignment from
// accidentally retaining the same photo in both answer-page slots.
async function openFile(f, forcedPage = undefined, seenPages = null) {
  uploadSeq++;
  savedThisSheet = false;
  $('#saveMessage').textContent = '';
  pdfDoc = null;
  $('#pdfnav').hidden = true;
  points = [];
  image = null;
  $('#pointstatus').textContent = 'Opening file…';
  try {
    const bytes = await f.arrayBuffer();
    const fingerprint = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('') : crypto.randomUUID();
    currentFileFingerprint = fingerprint;
    await modelReady;
    if (isPdf(f)) {
      pdfDoc = await pdfjsLib.getDocument({
        data: new Uint8Array(bytes)
      }).promise;
      if (pdfDoc.numPages > 2) throw Error('Upload only one student’s two answer pages at a time.');
      if (pdfDoc.numPages === 2) startCombinedPages();
      $('#pdfnav').hidden = pdfDoc.numPages === 1;
      for (pdfPage = 1; pdfPage <= pdfDoc.numPages; pdfPage++) await showPdfPage(true);
      pdfPage = pdfDoc.numPages;
      $('#reassign').disabled = false;
      return true;
    } else {
      const url = URL.createObjectURL(f),
        im = new Image();
      try {
        await new Promise((resolve, reject) => {
          im.onload = resolve;
          im.onerror = () => reject(Error('Could not open photo. Please use JPG or PNG.'));
          im.src = url
        });
        image = scaledImage(im)
      } finally {
        URL.revokeObjectURL(url)
      }
      currentSource = `${currentFileFingerprint}:image`;
      points = [];
      draw();
      $('#reassign').disabled = false;
      return await autoRead(forcedPage === undefined ? selectedPage() : forcedPage, seenPages);
    }
  } catch (err) {
    $('#pointstatus').textContent = err.message;
    console.error(err)
    return false;
  }
}

function setUploadBusy(value) {
  $('#saveResult').disabled = true;
  $('#saveDraft').disabled = true;
  $('#confirmAll').disabled = true;
  if (!value && results.length) updateScore();
  for (const id of ['uploadP1', 'uploadP2', 'uploadPhotos', 'uploadPdf', 'file', 'camera', 'reassign']) $('#' + id).disabled = value;
  $('#reassign').disabled = value || !image
}
$('#reset').onclick = async () => {
  if (image && !busy) {
    points = [];
    draw();
    await autoRead(selectedPage())
  }
};
// Projective mapping from the template marker centres to the four selected image points.
async function autoRead(forcedPage = null, seenPages = null) {
  if (!image) return false;
  const ownBusy = !busy;
  if (ownBusy) {
    busy = true;
    setUploadBusy(true);
  }
  try {
    await modelReady;
    $('#pointstatus').textContent = 'ML reader: locating the page and reading its bubbles…';
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height),
      detection = detectPage(data, forcedPage);
    if (seenPages?.has(detection.page)) throw Error(`Both photos were detected as Page ${detection.page}. Upload one photo for each page, or assign them using the individual page buttons.`);
    points = detection.points;
    lastTemplate = detection.page;
    currentAlignment = {
      ...detection,
      source: currentSource
    };
    storePagePreview(lastTemplate, detection.h, data);
    seenPages?.add(lastTemplate);
    const rollReading = readRollFromPage(data, detection);
    const success = readSheet(lastTemplate);
    if (!success) draw();
    await rollReading;
    if (success) {
      $('#pageChoice').value = String(lastTemplate);
      if (pdfDoc) pdfAssignments.set(pdfPage, lastTemplate)
    }
    return success;
  } catch (err) {
    points = [];
    draw();
    $('#pointstatus').textContent = err.message;
    console.error(err);
    return false
  } finally {
    if (ownBusy) {
      busy = false;
      setUploadBusy(false);
    }
  }
}

// A question selects every option whose marked probability exceeds 0.5.
// The shared review policy keeps app behavior identical to the benchmark.
function readSheet(page) {
  try {
    if (key.length !== count) {
      $('#pointstatus').textContent = 'Save a valid answer key, then press Read as selected page.';
      return false
    }
    const h = currentAlignment?.h || homography(points);
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height),
      entries = [];
    const previousSource = pageSources.get(page);
    const start = (page === 1 ? 1 : 31),
      end = Math.min(start + 30, count + 1);
    for (let q = start; q < end; q++) {
      const reading = readQuestion(h, data, page, q, key[q - 1]);
      const crop = questionCrop(h, data, page, q);
      const preview = document.createElement('canvas');
      preview.width = crop.width;
      preview.height = crop.height;
      preview.getContext('2d').putImageData(new ImageData(crop.data, crop.width, crop.height), 0, 0);
      entries.push({
        ...reading,
        detectedSelected: reading.selected,
        reader: 'augmented-cnn',
        preview: preview.toDataURL('image/jpeg', .82)
      });
    }
    // Reassignment moves this source image, rather than leaving it in both slots.
    for (const [slot, source] of pageSources) {
      if (source === currentSource && slot !== page) {
        pages.delete(slot);
        pagePreviews.delete(slot);
        pageSources.delete(slot);
        if (slot === 2) correctionSection = createCorrectionSection()
      }
    }
    pages.set(page, entries);
    pageSources.set(page, currentSource);
    if (page === 1 && previousSource !== currentSource && correctionSection.verified) {
      // Keep the confirmed replacement but require another visual check that
      // this changed main page belongs with the existing correction page.
      correctionSection = {
        ...correctionSection,
        verified: false,
        identityReviewRequired: true
      };
    }
    updateSlots();
    if (page === 2) {
      // Always start fresh for a new correction scan. Reusing prior approvals
      // here could silently apply another photograph's corrections.
      const scan = scanCorrections(h, data, currentSource);
      scan.preview = rasterUrl(scan.raster);
      delete scan.raster;
      scan.rows = scan.rows.map(({
        raster,
        numberCrop,
        ...row
      }) => ({
        ...row,
        preview: rasterUrl(raster),
        numberPreview: numberCrop.blank ? '' : rollPreview(numberCrop)
      }));
      correctionSection = scan;
    }
    recomputeResults();
    draw();
    $('#pointstatus').textContent = `CNN read Page ${page} · Q${start}–${end-1}. ${h.grid?'Bubble grid aligned from photo.':'Template alignment.'} ${pages.size}/2 page(s) collected. ${results.filter(r=>r.flag&&!r.missing).length} answers need review.`;
    $('#result').hidden = false;
    render();
    if (!busy && pages.size >= (count > 30 ? 2 : 1)) $('#result').scrollIntoView({
      behavior: 'smooth'
    });
    return true;
  } catch (err) {
    $('#pointstatus').textContent = 'Could not read this page. Retake a flat, well-lit photo of the entire page.';
    console.error(err);
    return false
  }
}

function rasterUrl(raster) {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  canvas.getContext('2d').putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
  return canvas.toDataURL('image/jpeg', .82);
}

function baseResponses() {
  return Array.from({
    length: count
  }, (_, index) => pages.get(index < 30 ? 1 : 2)?.[index % 30] || {
    selected: '',
    flag: true,
    missing: true
  });
}

function baseResponse(question) {
  return pages.get(question <= 30 ? 1 : 2)?.[(question - 1) % 30];
}

function recomputeResults() {
  results = effectiveResponses(pages, count, correctionSection);
}

function changeCorrections(next, refreshPanel = true) {
  correctionSection = next;
  savedThisSheet = false;
  recomputeResults();
  render(refreshPanel);
  draw();
}

function renderCorrections() {
  renderCorrectionPanel({
    box: $('#corrections'),
    getSection: () => correctionSection,
    count,
    baseResponses: baseResponses(),
    onChange: changeCorrections
  });
}

function render(refreshPanel = true) {
  if (refreshPanel) renderCorrections();
  const box = $('#answers');
  box.replaceChildren();
  // Reorder only the view. Original indexes still select the right answer
  // key and CSV column, and remain attached to the shared page entries.
  const groupFor = response => response.missing ? 2 : response.flag ? 0 : 1;
  const ordered = results.map((response, index) => ({
    response,
    index
  })).sort((a, b) =>
    groupFor(a.response) - groupFor(b.response) || a.index - b.index);
  let previousGroup = -1;
  ordered.forEach(({
    response,
    index
  }) => {
    const group = groupFor(response);
    if (group !== previousGroup) {
      const heading = document.createElement('h3');
      heading.className = 'review-group';
      heading.textContent = ['Needs manual confirmation', 'Other answers', 'Awaiting page upload'][group];
      box.append(heading);
      previousGroup = group;
    }
    const question = index + 1;
    const row = document.createElement('div');
    row.dataset.question = String(question);
    row.className = response.flag ? 'answer flag' : 'answer';
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Q' + question + (response.missing ? ' · page not uploaded' : '');
    const options = document.createElement('div');
    options.className = 'row';
    choices.forEach(choice => {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = choice;
      checkbox.disabled = !!response.missing || response.answerSource === 'correction';
      checkbox.checked = response.selected.includes(choice);
      label.append(checkbox, choice);
      options.appendChild(label);
    });
    const verdict = document.createElement('span');
    const updateVerdict = () => {
      if (response.missing) {
        verdict.textContent = 'Awaiting page';
        verdict.setAttribute('aria-label', 'Awaiting page');
        return
      }
      const correct = response.selected === key[index];
      verdict.textContent = correct ? '✓ Correct' : `× Wrong · key ${key[index].split('').join('+')}`;
      verdict.setAttribute('aria-label', correct ? 'Correct' : 'Incorrect');
    };
    updateVerdict();
    options.appendChild(verdict);
    fieldset.append(legend, options);
    const detection = document.createElement('p');
    detection.className = 'detected-options';
    const optionText = value => value === null || value === undefined ? 'unavailable' : value.split('').join('+') || 'Blank';
    detection.textContent = `CNN detected: ${optionText(response.detectedSelected)}`;
    if (response.answerSource === 'correction') {
      const corrected = document.createElement('p');
      corrected.className = 'corrected-answer';
      corrected.textContent = `Final response: ${optionText(response.selected)} · correction row ${response.correctionRow}`;
      fieldset.append(corrected);
      if (response.correctionPreview) {
        const crop = document.createElement('img');
        crop.className = 'correction-replacement';
        crop.src = response.correctionPreview;
        crop.alt = `Confirmed correction for question ${question}`;
        fieldset.append(crop);
      }
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary';
      edit.textContent = 'Edit correction';
      edit.onclick = () => {
        changeCorrections(editCorrection(correctionSection, response.correctionRow));
        document.querySelector(`[data-correction-row="${response.correctionRow}"]`)?.scrollIntoView({
          block: 'center'
        });
      };
      fieldset.append(edit);
    }
    if (response.preview) {
      const crop = document.createElement('img');
      crop.className = 'response-crop';
      crop.src = response.preview;
      crop.alt = `Student response for question ${question}; question number on the left, options A, B, C, D from left to right`;
      fieldset.insertBefore(crop, options);
    } else {
      const placeholder = document.createElement('p');
      placeholder.className = 'crop-missing';
      placeholder.textContent = response.missing ? 'Upload this page to see the response.' : 'Upload this page again to show its response crop.';
      fieldset.insertBefore(placeholder, options);
    }
    fieldset.insertBefore(detection, options);
    let note, confirm;
    if (response.flag && !response.missing) {
      note = document.createElement('span');
      note.className = 'reason';
      note.textContent = 'ML reading is uncertain — confirm or correct';
      confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'secondary confirm';
      confirm.textContent = 'Confirm reading';
      confirm.onclick = () => {
        baseResponse(question).flag = false;
        savedThisSheet = false;
        recomputeResults();
        render();
      };
      fieldset.append(note, confirm);
    }
    row.appendChild(fieldset);
    box.appendChild(row);
    fieldset.onchange = () => {
      const original = baseResponse(question);
      original.selected = Array.from(options.querySelectorAll('input:checked'), input => input.value).join('');
      original.flag = false;
      recomputeResults();
      row.classList.remove('flag');
      note?.remove();
      confirm?.remove();
      savedThisSheet = false;
      $('#saveMessage').textContent = 'Answers changed. Save again if needed.';
      updateVerdict();
      updateScore();
      draw();
      render();
    };
  });
  updateScore();
}

// The pure resultState() module owns completion rules, shared with tests.
function currentResultState() {
  return resultState({
    name: $('#student').value,
    rollNumber: identity.rollNumber,
    rollPending: identity.pending,
    count,
    key,
    pages: pages.keys(),
    results,
    correctionSection,
    busy
  })
}

function updateScore() {
  const state = currentResultState();
  $('#score').textContent = state.missingPages.length ? `${state.score} / ${state.scanned} scanned (${count} questions total)` : `${state.score} / ${count}`;
  $('#flagcount').textContent = `${state.flagged.length} answers, ${state.pendingCorrections} corrections pending review${state.correctionSectionPending?' · Correction-section check pending':''}`;
  $('#saveResult').disabled = !state.canFinalize;
  $('#saveDraft').disabled = !state.canSaveProgress;
  $('#confirmAll').disabled = busy || !state.flagged.length;
  $('#saveRequirements').textContent = state.canFinalize ? 'Ready to save the completed result.' : state.blockers.join(' ') + (state.scanned ? ' You can save progress before finishing.' : '');
}
$('#confirmAll').onclick = () => {
  if (busy) return;
  confirmAllAnswers(baseResponses());
  recomputeResults();
  savedThisSheet = false;
  $('#saveMessage').textContent = 'Current readings confirmed for all scanned questions.';
  render();
};
$('#student').addEventListener('input', () => {
  savedThisSheet = false;
  if (results.length) updateScore()
});
let saved = [];
try {
  let v = JSON.parse(localStorage.getItem('paperscore-results') || '[]');
  if (Array.isArray(v)) saved = v
} catch (e) {};

function persist() {
  try {
    localStorage.setItem('paperscore-results', JSON.stringify(saved));
    return true
  } catch (e) {
    $('#saveMessage').textContent = 'Browser storage is unavailable or full. Download this result as CSV to keep a copy.';
    return false
  }
}

function showSaved() {
  const box = $('#savedList');
  box.replaceChildren();
  const drafts = saved.filter(r => r.status === 'draft').length;
  $('#savedCount').textContent = `${saved.length} saved result${saved.length===1?'':'s'}${drafts?' · '+drafts+' incomplete':''}`;
  if (!saved.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No results saved yet.';
    box.appendChild(p);
    return
  }
  saved.forEach((rec, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'border-top:1px solid #e2e9ef;padding:10px 0';
    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = rec.status === 'draft' ? `${studentLabel(rec)} — Incomplete · ${rec.score} / ${rec.scannedQuestions} scanned (${rec.total} questions total)` : `${studentLabel(rec)} — ${rec.score} / ${rec.total} · Complete`;
    row.append(label);
    if (rec.status === 'draft') {
      const resume = document.createElement('button');
      resume.className = 'secondary';
      resume.textContent = 'Resume';
      resume.onclick = () => resumeDraft(rec);
      row.append(resume);
    }
    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = 'Delete';
    del.onclick = () => {
      if (confirm(`Delete saved result for ${studentLabel(rec)}?`)) {
        const old = saved.splice(i, 1)[0];
        if (!persist()) saved.splice(i, 0, old);
        showSaved()
      }
    };
    row.append(del);
    box.append(row);
  });
}

// Restore responses, flags and compressed page previews. Full-resolution
// source photos are not saved; alignment can be retried after re-uploading.
function resumeDraft(rec) {
  if (results.length && !savedThisSheet && !confirm('Replace the current unsaved scan with this saved progress?')) return;
  clearPages();
  activeResultId = rec.id;
  count = rec.total;
  key = [...rec.key];
  $('#count').value = count;
  $('#key').value = key.map(a => a.split('').join('+')).join(' ');
  $('#student').value = rec.name;
  identityEpoch++;
  identity = createIdentity(rec.rollIdentity || {
    rollNumber: rec.rollNumber || '',
    manual: !!rec.rollNumber
  });
  renderIdentity();
  $('#keystatus').textContent = 'Answer key restored with saved progress';
  const restored = (rec.baseResponses || rec.responses || []).map(response => ({
    ...response,
    ...(!rec.schemaVersion ? {
      flag: !response.missing,
      selected: response.detectedSelected ?? response.selected,
      detectedSelected: undefined
    } : {})
  }));
  for (const p of rec.pagesReceived) {
    const start = (p - 1) * 30;
    pages.set(p, restored.slice(start, Math.min(start + 30, count)));
  }
  for (const [page, source] of rec.pageSources || []) pageSources.set(page, source);
  for (const [page, savedPreview] of rec.pagePreviews || []) {
    const base = new Image(),
      entry = {
        base,
        circles: savedPreview.circles || []
      };
    pagePreviews.set(page, entry);
    base.onload = () => {
      if (pagePreviews.get(page) === entry) drawPagePreviews();
    };
    base.src = savedPreview.base;
  }
  drawPagePreviews();
  correctionSection = rec.correctionSection || createCorrectionSection();
  // Older drafts have no saved correction scan or proof that its bounds were
  // visible. A full-page thumbnail cannot establish this: require Page 2 again.
  if (!rec.correctionSection && pages.has(2)) {
    const source = 'legacy:' + rec.id;
    correctionSection = {
      ...createCorrectionSection(),
      scanned: true,
      visible: false,
      requiresRescan: true,
      source,
      preview: (rec.pagePreviews || []).find(([page]) => page === 2)?.[1]?.base || '',
      rows: Array.from({
        length: 10
      }, (_, i) => {
        const old = (rec.corrections || []).find(row => row.row === i + 1);
        return {
          row: i + 1,
          question: old?.question || '',
          selected: old?.selected || '',
          detectedSelected: old?.selected || '',
          candidate: !!old,
          status: old ? 'pending' : 'empty',
          source
        };
      })
    };
  }
  recomputeResults();
  image = null;
  points = [];
  pdfDoc = null;
  $('#pdfnav').hidden = true;
  cv.width = 0;
  cv.height = 0;
  savedThisSheet = true;
  $('#result').hidden = false;
  $('#reset').disabled = true;
  $('#reassign').disabled = true;
  updateSlots();
  render();
  $('#pointstatus').textContent = 'Saved progress restored. Upload any missing page to finish.';
  $('#saveMessage').textContent = 'Progress restored. Final saving updates this same result.';
  $('#result').scrollIntoView({
    behavior: 'smooth'
  });
}

// Reuse the draft ID when finalizing so one student does not get duplicate
// records. Roll back the in-memory update if browser storage fails.
function saveRecord(status) {
  const state = currentResultState();
  if (status === 'complete' && !state.canFinalize) {
    $('#saveMessage').textContent = state.blockers.join(' ');
    return
  }
  if (!state.canSaveProgress) {
    $('#saveMessage').textContent = !($('#student').value.trim() || identity.rollNumber.trim()) ? 'Enter a student name or roll number first.' : 'Read an answer page and save a valid key first.';
    return
  }
  const previous = activeResultId ? saved.findIndex(r => r.id === activeResultId) : -1;
  if (status === 'complete' && savedThisSheet && previous >= 0 && saved[previous].status !== 'draft') {
    $('#saveMessage').textContent = 'This completed result is already saved.';
    return
  }
  const id = activeResultId || crypto.randomUUID();
  const rec = {
    id,
    schemaVersion: 2,
    reader: 'augmented-cnn',
    status,
    name: $('#student').value.trim(),
    rollNumber: identity.rollNumber.trim(),
    score: state.score,
    total: count,
    scannedQuestions: state.scanned,
    flags: state.flagged.length + state.pendingCorrections,
    pagesReceived: [...pages.keys()].sort(),
    pageSources: [...pageSources],
    answers: results.map(r => r.missing ? 'Not uploaded' : r.selected || 'Blank'),
    answerSources: results.map(r => r.answerSource === 'correction' ? `correction row ${r.correctionRow}` : 'main'),
    baseResponses: baseResponses().map(({
      selected,
      flag,
      missing,
      detectedSelected
    }) => ({
      selected,
      flag,
      missing,
      detectedSelected
    })),
    correctionSection: correctionAudit(correctionSection, status === 'draft'),
    key: [...key],
    savedAt: new Date().toISOString()
  };
  if (status === 'draft') {
    rec.pagePreviews = Array.from(pagePreviews, ([page, entry]) => {
      const base = entry.base instanceof HTMLCanvasElement ? entry.base.toDataURL('image/jpeg', .8) : entry.base.src;
      return [page, {
        base,
        circles: entry.circles
      }];
    });
    rec.rollIdentity = {
      ...identity
    };
    rec.baseResponses = baseResponses().map(({
        selected,
        flag,
        missing,
        preview,
        detectedSelected,
        reader
      }) =>
      ({
        selected,
        flag: !!flag,
        missing: !!missing,
        preview,
        detectedSelected,
        reader
      }));
    rec.responses = results.map(({
        selected,
        flag,
        missing,
        preview,
        detectedSelected,
        reader
      }) =>
      ({
        selected,
        flag: !!flag,
        missing: !!missing,
        preview,
        detectedSelected,
        reader
      }));
  }
  const old = previous >= 0 ? saved[previous] : null;
  if (previous >= 0) saved[previous] = rec;
  else saved.push(rec);
  if (!persist()) {
    if (previous >= 0) saved[previous] = old;
    else saved.pop();
    return
  }
  activeResultId = id;
  savedThisSheet = true;
  $('#saveMessage').textContent = status === 'draft' ? 'Progress saved as Incomplete. Use Resume in the results list to finish later.' : 'Completed result saved to the results list.';
  showSaved();
}
$('#saveResult').onclick = () => saveRecord('complete');
$('#saveDraft').onclick = () => saveRecord('draft');
$('#nextStudent').onclick = () => {
  if (!savedThisSheet && !confirm('This result has not been saved. Start the next student anyway?')) return;
  activeResultId = null;
  $('#student').value = '';
  identityEpoch++;
  identity = createIdentity();
  renderIdentity();
  $('#file').value = '';
  image = null;
  points = [];
  pdfDoc = null;
  clearPages();
  correctionSection = createCorrectionSection();
  savedThisSheet = false;
  $('#pdfnav').hidden = true;
  $('#result').hidden = true;
  $('#saveMessage').textContent = '';
  $('#pointstatus').textContent = 'Choose the next student’s file';
  $('#reset').disabled = true;
  $('#reassign').disabled = true;
  cv.width = 0;
  cv.height = 0;
  $('#file').scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });
  $('#student').focus()
};

// Quote CSV values and neutralize leading spreadsheet formula characters.
function csvSafe(x) {
  let t = String(x ?? '');
  if (/^[\s]*[=+@\-]/.test(t)) t = "'" + t;
  return '"' + t.replaceAll('"', '""') + '"'
}

const csvHeader = ['Roll number', 'Total score', ...Array.from({
  length: 60
}, (_, i) => 'Q' + (i + 1))];

function csvAnswers(answers) {
  return Array.from({
    length: 60
  }, (_, i) => answers[i] ?? '');
}

$('#exportAll').onclick = () => {
  if (!saved.length) {
    alert('No saved results yet.');
    return
  }
  const rows = [
    csvHeader,
    ...saved.map(r => [r.rollNumber || '', r.score, ...csvAnswers(r.answers || [])])
  ];
  downloadCsv(rows, 'paperscore-all-results.csv');
};
showSaved();
$('#download').onclick = () => {
  const state = currentResultState();
  const answers = results.map(r => r.missing ? 'Not uploaded' : r.selected || 'Blank');
  const rows = [
    csvHeader,
    [identity.rollNumber || '', state.score, ...csvAnswers(answers)]
  ];
  downloadCsv(rows, 'paperscore-result.csv');
};

function downloadCsv(rows, name) {
  const csv = rows.map(row => row.map(csvSafe).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], {
    type: 'text/csv;charset=utf-8'
  }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
