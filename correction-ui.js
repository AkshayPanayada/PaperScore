import {
  correctionIssues,
  editCorrection,
  confirmCorrection,
  ignoreCorrection,
  verifyCorrectionSection
} from './corrections.js?v=12';
import {
  recognizeQuestionNumber
} from './roll-number.js?v=12';

const choices = ['A', 'B', 'C', 'D'];
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const picture = (source, alt) => {
  const image = node('img', null, 'response-crop');
  image.src = source;
  image.alt = alt;
  return image;
};

export function renderCorrectionPanel({
  box,
  getSection,
  count,
  baseResponses,
  onChange
}) {
  box.replaceChildren();
  box.append(node('h3', 'Corrections — review first'));
  const section = getSection();
  if (!section.scanned) {
    box.append(node('p', 'Upload Page 2 to inspect the correction section, including for tests with 30 or fewer questions.', 'note'));
    return;
  }
  box.append(node('p', 'Inspect all ten rows. Confirm each correction’s question number and replacement options, then confirm the whole section.', 'note'));
  if (section.preview) box.append(picture(section.preview, 'Complete correction section, including all ten rows'));
  if (section.requiresRescan) box.append(node('p', 'This older draft has no correction-section scan. Re-upload Page 2 to inspect and confirm its corrections.', 'error'));
  else if (!section.visible) box.append(node('p', 'The correction section is clipped. Upload a complete Page 2 before final saving.', 'error'));
  else if (!section.reliable) box.append(node('p', 'Correction-grid alignment is uncertain. Inspect the full page and add any correction the reader missed.', 'note'));
  if (section.identityReviewRequired) box.append(node('p', 'The original answer page changed. Verify that both pages belong to the same student before confirming this section.', 'note'));
  const status = node('p', null, 'statusline');
  status.id = 'correctionStatus';
  box.append(status);
  const cards = node('div', null, 'correction-cards');
  box.append(cards);
  const invalid = new Set(correctionIssues(section, count).invalid);
  for (const initial of section.rows.filter(row => row.status !== 'empty').sort((a, b) =>
      Number(!(a.status === 'pending' || invalid.has(a.row))) - Number(!(b.status === 'pending' || invalid.has(b.row))) || a.row - b.row)) {
    const card = node('article', null, initial.status === 'pending' ? 'correction-card flag' : 'correction-card');
    card.dataset.correctionRow = initial.row;
    card.append(node('h4', `Correction row ${initial.row} · ${initial.status}`));
    if (initial.preview) card.append(picture(initial.preview, `Correction row ${initial.row}, handwritten question number and answer bubbles`));
    if (initial.status === 'ignored' || initial.status === 'superseded') {
      card.append(node('p', initial.reason || initial.status));
      const reopen = node('button', 'Review this row again', 'secondary');
      reopen.type = 'button';
      reopen.onclick = () => onChange(editCorrection(getSection(), initial.row));
      card.append(reopen);
      cards.append(card);
      continue;
    }
    const form = node('div', null, 'row');
    const label = node('label', 'Question number '),
      input = node('input');
    input.type = 'number';
    input.min = 1;
    input.max = count;
    input.step = 1;
    input.value = initial.question || '';
    input.setAttribute('aria-label', `Question number for correction ${initial.row}`);
    label.append(input);
    form.append(label);
    const optionBox = node('fieldset', null, 'correction-options');
    optionBox.append(node('legend', 'Replacement answer'));
    for (const choice of choices) {
      const optionLabel = node('label'),
        checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.value = choice;
      checkbox.checked = initial.selected.includes(choice);
      checkbox.setAttribute('aria-label', `Correction ${initial.row} option ${choice}`);
      optionLabel.append(checkbox, choice);
      optionBox.append(optionLabel);
    }
    form.append(optionBox);
    card.append(form);
    const original = node('div', null, 'correction-original');
    card.append(original);
    const error = node('p', null, 'error');
    error.setAttribute('role', 'status');
    card.append(error);
    const selected = () => Array.from(optionBox.querySelectorAll('input:checked'), element => element.value).join('');
    const refreshOriginal = () => {
      original.replaceChildren();
      const q = Number(input.value),
        base = baseResponses[q - 1];
      if (Number.isInteger(q) && q >= 1 && q <= count) {
        original.append(node('p', `Q${q}: original ${base?.missing?'page not uploaded':base?.selected||'Blank'} → replacement ${selected()||'not selected'}`));
        if (base?.preview) original.append(picture(base.preview, `Original response for question ${q}`));
      }
    };
    const edited = () => {
      error.textContent = '';
      onChange(editCorrection(getSection(), initial.row, {
        question: input.value,
        selected: selected()
      }), false);
      card.classList.add('flag');
      card.querySelector('h4').textContent = `Correction row ${initial.row} · pending`;
      refreshOriginal();
      refreshStatus();
    };
    input.oninput = edited;
    optionBox.onchange = edited;
    refreshOriginal();
    const actions = node('div', null, 'row');
    const confirm = node('button', 'Confirm correction');
    confirm.type = 'button';
    const replace = node('button', 'Use this row instead', 'secondary');
    replace.type = 'button';
    replace.hidden = true;
    const apply = replaceOther => {
      try {
        onChange(confirmCorrection(getSection(), initial.row, input.value, selected(), count, replaceOther));
      } catch (failure) {
        error.textContent = failure.message;
        replace.hidden = !/Another correction/.test(failure.message);
      }
    };
    confirm.onclick = () => apply(false);
    replace.onclick = () => apply(true);
    actions.append(confirm, replace);
    const suggest = node('button', 'Suggest question number', 'secondary');
    suggest.type = 'button';
    suggest.disabled = !initial.numberPreview;
    suggest.onclick = async () => {
      const before = getSection(),
        row = before.rows.find(row => row.row === initial.row),
        version = row.editVersion || 0;
      suggest.disabled = true;
      error.textContent = 'Reading the handwritten number…';
      try {
        const image = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = initial.numberPreview;
        });
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data,
          pixels = Uint8Array.from({
            length: canvas.width * canvas.height
          }, (_, i) => rgba[i * 4]);
        const number = await recognizeQuestionNumber({
          pixels,
          width: canvas.width,
          height: canvas.height,
          blank: false
        }, count);
        const current = getSection(),
          now = current.rows.find(row => row.row === initial.row);
        // An OCR job may finish after a manual confirmation, undo or re-upload.
        // Only apply it while this exact row decision is still current.
        if (current.source === before.source && now === row && (now.editVersion || 0) === version) {
          if (number) onChange(editCorrection(current, initial.row, {
            question: number
          }));
          else error.textContent = 'Could not read a valid question number. Enter the number visible in the crop.';
        }
      } catch {
        error.textContent = 'Number recognition is unavailable. Enter the number manually.';
      } finally {
        suggest.disabled = false;
      }
    };
    actions.append(suggest);
    const reason = node('select');
    reason.setAttribute('aria-label', `Reason to ignore correction ${initial.row}`);
    for (const [value, text] of [
        ['', 'Choose reason…'],
        ['empty-artifact', 'Empty row or printing artifact'],
        ['cancelled', 'Cancelled on paper'],
        ['not-correction', 'Not a student correction']
      ]) {
      const option = node('option', text);
      option.value = value;
      reason.append(option);
    }
    const ignore = node('button', 'Mark row unused', 'secondary');
    ignore.type = 'button';
    ignore.disabled = true;
    reason.onchange = () => {
      ignore.disabled = !reason.value;
    };
    ignore.onclick = () => onChange(ignoreCorrection(getSection(), initial.row, reason.value));
    actions.append(reason, ignore);
    card.append(actions);
    cards.append(card);
  }
  const add = node('div', null, 'row'),
    rowSelect = node('select');
  rowSelect.setAttribute('aria-label', 'Missed correction row');
  for (const row of section.rows.filter(row => row.status === 'empty')) {
    const option = node('option', `Row ${row.row}`);
    option.value = row.row;
    rowSelect.append(option);
  }
  const addButton = node('button', 'Add a missed correction', 'secondary');
  addButton.type = 'button';
  addButton.disabled = !rowSelect.options.length;
  addButton.onclick = () => onChange(editCorrection(getSection(), Number(rowSelect.value)));
  add.append(rowSelect, addButton);
  box.append(add);
  const verify = node('button');
  verify.id = 'confirmCorrectionSection';
  verify.type = 'button';
  verify.onclick = () => {
    try {
      onChange(verifyCorrectionSection(getSection(), count));
    } catch (error) {
      status.textContent = error.message;
    }
  };
  box.append(verify);

  function refreshStatus() {
    const current = getSection(),
      issues = correctionIssues(current, count);
    const pending = [...new Set([...issues.pending, ...issues.invalid])];
    status.textContent = issues.duplicates.length ? `Resolve duplicate corrections for ${issues.duplicates.map(group=>'Q'+group.question).join(', ')}.` :
      pending.length ? `Review correction row(s) ${pending.join(', ')}.` : current.verified ? 'Correction section confirmed.' : 'Check the whole correction section, including rows the reader may have missed.';
    verify.textContent = current.verified ? 'Correction section confirmed' : current.rows.every(row => row.status === 'empty') ? 'Confirm no corrections' : 'Confirm corrections section';
    verify.disabled = current.verified || !issues.canVerify;
  }
  refreshStatus();
}
