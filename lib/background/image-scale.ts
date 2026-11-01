/**
 * Fits an image the user attached for the model: its longest side at most
 * `maxDimension` pixels, re-encoded as JPEG when it is larger (or its file is
 * heavy), decoded and drawn with the background page's `createImageBitmap`
 * and `OffscreenCanvas`. The workspace keeps the original bytes; only the
 * model's copy is scaled. Injectable (`ProgramScope.scaleImage`) so tests can
 * fake it.
 */

import { base64ToBytes, bytesToBase64 } from "@/lib/domain/pdf";
import { base64Bytes } from "@/lib/validation";

/** An image as base64 (no data-URL prefix) with its pixel size. */
export interface ScaledImage {
  mimeType: string;
  data: string;
  width: number;
  height: number;
}

/** Returns the image to show the model; throws `ImageScaleError` when it cannot be decoded. */
export type ImageScaler = (image: { mimeType: string; data: string }, maxDimension: number) => Promise<ScaledImage>;

/** An image bside could not decode; its message is safe to show the model. */
export class ImageScaleError extends Error {}

/** An image within the size that is still re-encoded, so a heavy file never goes to the model as is. */
const MAX_UNSCALED_BYTES = 1_500_000;
const JPEG_QUALITY = 0.85;

export const scaleImageInPage: ImageScaler = async ({ mimeType, data }, maxDimension) => {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") throw new ImageScaleError("Images cannot be decoded here.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([base64ToBytes(data) as Uint8Array<ArrayBuffer>], { type: mimeType })); }
  catch { throw new ImageScaleError("The image could not be decoded; it may be damaged or not the type it claims."); }
  try {
    const { width, height } = bitmap;
    if (!width || !height) throw new ImageScaleError("The image is empty.");
    const fit = Math.min(1, maxDimension / Math.max(width, height));
    if (fit === 1 && (base64Bytes(data) ?? Infinity) <= MAX_UNSCALED_BYTES) return { mimeType, data, width, height };
    const scaled = { width: Math.max(1, Math.round(width * fit)), height: Math.max(1, Math.round(height * fit)) };
    const canvas = new OffscreenCanvas(scaled.width, scaled.height);
    const context = canvas.getContext("2d");
    if (!context) throw new ImageScaleError("Images cannot be decoded here.");
    // JPEG has no transparency: transparent pixels show white, as on most pages.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, scaled.width, scaled.height);
    context.drawImage(bitmap, 0, 0, scaled.width, scaled.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    return { mimeType: "image/jpeg", data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), ...scaled };
  } catch (error) {
    throw error instanceof ImageScaleError ? error : new ImageScaleError("The image could not be resized.");
  } finally {
    bitmap.close();
  }
};
