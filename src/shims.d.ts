declare module 'libheif-js' {
  const libheif: any;
  export default libheif;
}

declare module 'gifenc' {
  export function GIFEncoder(): any;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: Record<string, unknown>,
  ): any[];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: any[],
    format?: string,
  ): Uint8Array;
}