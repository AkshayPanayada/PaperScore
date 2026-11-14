// Handwriting runs in a dedicated worker so the answer-review UI stays usable.
// Model weights and ONNX/WASM runtime are served from this site's own assets.
import {
  pipeline,
  env,
  RawImage
} from './ocr-assets/transformers/transformers.min.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./ocr-assets/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./ocr-assets/transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
let recognizer;
async function recognize({
  id,
  width,
  height,
  pixels
}) {
  try {
    if (!recognizer) recognizer = pipeline('image-to-text', 'handwriting', {
      dtype: 'q8',
      device: 'wasm',
      local_files_only: true
    });
    const reader = await recognizer;
    const rgb = new Uint8ClampedArray(width * height * 3);
    for (let i = 0; i < pixels.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = pixels[i];
    const output = await reader(new RawImage(rgb, width, height, 3), {
      max_new_tokens: 32
    });
    self.postMessage({
      id,
      text: output[0]?.generated_text || ''
    });
  } catch (error) {
    recognizer = null;
    self.postMessage({
      id,
      error: error.message
    });
  }
}

// One model job at a time, including roll and correction-number requests.
let queue = Promise.resolve();
self.onmessage = ({
  data
}) => {
  queue = queue.then(() => recognize(data));
};
