import { registerPlugin, Capacitor } from '@capacitor/core';

export interface PickedImage {
  id: string;
  contentUri: string;
  name: string;
  size: number;
  mimeType: string;
  base64: string;
}

export interface ReplaceImageOptions {
  contentUri: string;
  base64: string;
  mimeType: string;
}

export interface SaveImageOptions {
  base64: string;
  mimeType: string;
  displayName: string;
}

export interface PicturePlugin {
  requestPermissions(): Promise<void>;
  pickImages(): Promise<{ images: PickedImage[] }>;
  replaceImage(options: ReplaceImageOptions): Promise<void>;
  saveImage(options: SaveImageOptions): Promise<void>;
}

const Picture = registerPlugin<PicturePlugin>('Picture');

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export async function requestPermissions(): Promise<void> {
  if (isNative()) {
    await Picture.requestPermissions();
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function pickImagesNative(): Promise<PickedImage[]> {
  const result = await Picture.pickImages();
  return result.images;
}

export async function replaceImageNative(
  contentUri: string,
  compressedBuffer: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  const base64 = arrayBufferToBase64(compressedBuffer);
  await Picture.replaceImage({ contentUri, base64, mimeType });
}

export async function saveImageNative(
  compressedBuffer: ArrayBuffer,
  mimeType: string,
  displayName: string,
): Promise<void> {
  const base64 = arrayBufferToBase64(compressedBuffer);
  await Picture.saveImage({ base64, mimeType, displayName });
}

export function downloadBlob(buffer: ArrayBuffer, mimeType: string, filename: string): void {
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { base64ToArrayBuffer };