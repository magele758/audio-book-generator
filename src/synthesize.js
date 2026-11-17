import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAMPLE_RATE = 22050;
const MIN_SECONDS = 0.4;
const MAX_SECONDS = 30;

export function wavDurationSeconds(text) {
  const length = String(text ?? '').length;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, length / 40));
}

export function renderWav(text) {
  const seconds = wavDurationSeconds(text);
  const sampleCount = Math.round(seconds * SAMPLE_RATE);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  const frequency = 440;
  const amplitude = 0.25;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE) * amplitude;
    const value = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

export async function synthesizeToFile(text, filePath) {
  const wav = renderWav(text);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, wav);
  return wav.length;
}
