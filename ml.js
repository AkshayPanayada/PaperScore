// CNN readers share crop normalization and class order. Weights are bundled,
// and all inference happens on the device without a runtime ML dependency.
let model;
let loadedVariant;

export async function loadModel(data = null, variant = 'augmented') {
  if (!['cnn', 'augmented'].includes(variant)) throw Error('Only CNN readers are supported.');
  if (model && !data && loadedVariant === variant) return model;
  if (!data) {
    const name = variant === 'augmented' ? 'omr-augmented-model.json' : 'omr-cnn-model.json';
    const response = await fetch(new URL(`./${name}?v=11`, import.meta.url), {
      cache: 'no-cache'
    });
    if (!response.ok) throw Error('The ML reader could not load. Reload the page and try again.');
    data = await response.json();
  }
  // Tests can supply frozen weights directly to check JavaScript/Python parity.
  // The deployed app always selects the augmented CNN.
  for (const layer of data.layers) {
    if (layer.weights) layer.weights = Float32Array.from(layer.weights);
    if (layer.bias) layer.bias = Float32Array.from(layer.bias);
  }
  model = data;
  loadedVariant = data.variant || variant;
  return model;
}

function dense(input, layer) {
  const output = Float32Array.from(layer.bias);
  // Input-major layout: all weights leaving input i are stored consecutively.
  for (let i = 0; i < layer.input; i++) {
    const value = input[i],
      offset = i * layer.output;
    for (let j = 0; j < layer.output; j++) output[j] += value * layer.weights[offset + j];
  }
  return output;
}

function convolution(input, layer) {
  const {
    kernel,
    stride,
    channels,
    weights,
    bias
  } = layer;
  const size = Math.floor((layer.input - kernel) / stride) + 1;
  const output = new Float32Array(size * size * channels);
  // One grayscale input channel; output channels are last (y, x, filter).
  // Reuse each learned filter at every location to detect local ink patterns.
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * channels;
      output.set(bias, offset);
      for (let ky = 0; ky < kernel; ky++)
        for (let kx = 0; kx < kernel; kx++) {
          const value = input[(y * stride + ky) * layer.input + x * stride + kx];
          const weightOffset = (ky * kernel + kx) * channels;
          for (let c = 0; c < channels; c++) output[offset + c] += value * weights[weightOffset + c];
        }
      for (let c = 0; c < channels; c++) output[offset + c] = Math.max(0, output[offset + c]);
    }
  return output;
}

function averagePool(input, layer) {
  const {
    kernel,
    channels
  } = layer, size = layer.input / kernel;
  const output = new Float32Array(size * size * channels);
  // Non-overlapping 2x2 means reduce noise and the number of dense features.
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let dy = 0; dy < kernel; dy++)
          for (let dx = 0; dx < kernel; dx++) {
            sum += input[((y * kernel + dy) * layer.input + x * kernel + dx) * channels + c];
          }
        output[(y * size + x) * channels + c] = sum / (kernel * kernel);
      }
    }
  return output;
}

export function infer(input, suppliedModel = model) {
  if (!suppliedModel) throw Error('ML reader is still loading. Please try again.');
  let values = input;
  suppliedModel.layers.forEach((layer, index) => {
    if (layer.type === 'conv2d') values = convolution(values, layer);
    else if (layer.type === 'averagePool') values = averagePool(values, layer);
    else {
      // Dense layers combine the CNN's pooled spatial features into logits.
      values = dense(values, layer);
      if (index < suppliedModel.layers.length - 1) {
        for (let j = 0; j < values.length; j++) values[j] = Math.max(0, values[j]);
      }
    }
  });
  // Stable softmax turns four logits into class probabilities. These scores
  // are useful for review flags, but have not been calibrated on real photos.
  const max = Math.max(...values),
    exp = Array.from(values, value => Math.exp(value - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(value => value / sum);
}

export function normalizedPatch(sample) {
  const values = new Float32Array(24 * 24);
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) values[y * 24 + x] = sample(x, y);
  // The 90th percentile estimates local paper brightness under shadows.
  // Convert brightness into ink: paper=0, dark strokes=1, matching training.
  const sorted = Array.from(values).sort((a, b) => a - b),
    white = sorted[Math.floor(sorted.length * .9)];
  for (let i = 0; i < values.length; i++) values[i] = Math.max(0, Math.min(1, (white - values[i]) / Math.max(white, 80)));
  return values;
}

export function classifyProjected(gray, x, y, extent) {
  // extent is half the crop width in aligned page coordinates.
  return infer(normalizedPatch((px, py) => gray(x + (px + .5 - 12) * extent / 12, y + (py + .5 - 12) * extent / 12)));
}

export function classifyRectangle(image, rect) {
  const {
    data,
    width,
    height
  } = image, pad = 1.35, size = Math.max(rect.w, rect.h) * pad;
  return infer(normalizedPatch((px, py) => {
    const x = Math.max(0, Math.min(width - 1, Math.round(rect.x + (px + .5 - 12) * size / 24)));
    const y = Math.max(0, Math.min(height - 1, Math.round(rect.y + (py + .5 - 12) * size / 24)));
    const i = (y * width + x) * 4;
    return (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) / 256;
  }));
}
