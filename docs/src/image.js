// Proof photos: resize to ≤ 1280 px long edge, JPEG quality steps down until ≤ 150 KB.
// The bucket refuses anything over 300 KB, so that is the hard ceiling.
import { AppError } from './errors.js';

const TARGET = 150 * 1024;
const HARD_MAX = 300 * 1024;
const QUALITIES = [0.82, 0.72, 0.62, 0.52, 0.44, 0.36];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new AppError('IMAGE_BAD')); };
    img.src = url;   // iOS applies EXIF orientation to <img> automatically
  });
}
const toBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

// HEIC from the Files app can arrive with an empty or generic MIME type.
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif)$/i;

/** Any picked image (camera, 相簿, Files; JPEG/PNG/HEIC) → always re-encoded through a canvas to JPEG. */
export async function compressImage(file) {
  if (!file || (file.type && !file.type.startsWith('image/') && !IMAGE_EXT.test(file.name || ''))) throw new AppError('IMAGE_BAD');
  const img = await loadImage(file);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  if (!w0 || !h0) throw new AppError('IMAGE_BAD');
  let scale = Math.min(1, 1280 / Math.max(w0, h0));
  let best = null;
  for (let round = 0; round < 4; round++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * scale));
    c.height = Math.max(1, Math.round(h0 * scale));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    for (const q of QUALITIES) {
      const b = await toBlob(c, q);
      if (!b) throw new AppError('IMAGE_BAD');
      if (!best || b.size < best.size) best = b;
      if (b.size <= TARGET) return b;
    }
    c.width = c.height = 0;   // free iOS canvas memory
    scale *= 0.75;
  }
  if (best && best.size <= HARD_MAX) return best;
  throw new AppError('PROOF_TOO_BIG');
}

/** Test helper for ?mock=1: a small generated JPEG standing in for a camera photo. */
export async function fakePhoto() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 640, 480);
  grad.addColorStop(0, '#58CC02'); grad.addColorStop(1, '#1CB0F6');
  g.fillStyle = grad; g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#fff'; g.font = 'bold 56px sans-serif'; g.textAlign = 'center';
  g.fillText('📚 證明照片', 320, 250);
  return toBlob(c, 0.8);
}
