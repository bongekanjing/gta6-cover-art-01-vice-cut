// The grading worker: takes the painted poster's pixels and a grade description, returns graded pixels. Lives in its
// own module so the heavy per-pixel pass never stalls the editor's paint. Falls back to the main thread in render.js
// when a worker cannot start.

import { gradePixels } from './grade.js';

self.onmessage = (event) => {
  const { type, data, w, h, opts } = event.data ?? {};
  if (type !== 'grade') return;
  try {
    gradePixels(data, w, h, opts);
    self.postMessage({ type: 'done', data }, [data.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.message ? error.message : error) });
  }
};
