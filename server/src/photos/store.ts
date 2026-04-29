import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

export interface SavedPhoto {
  filename: string;
  size_bytes: number;
  width: number;
  height: number;
  path: string;
}

export interface SourcePhoto {
  buffer: Buffer;
  mimetype: string;
  originalFilename?: string;
}

/**
 * Process and persist a single photo to the local archive.
 * - Honours EXIF orientation via sharp().rotate() with no args.
 * - Re-encodes as JPEG q=85 (kills HEIC, normalises file size).
 * - Downscales to max 2000px on the longer side (avoids 12MP DSLR-sized
 *   files inflating the PDF and Splynx attachment).
 *
 * The destination path is data/photos/<task_id>/<submission_id>/<uuid>.jpg.
 */
export async function processAndSavePhoto(
  src: SourcePhoto,
  dataDir: string,
  taskId: number,
  submissionId: number,
): Promise<SavedPhoto> {
  const dir = path.join(dataDir, "photos", String(taskId), String(submissionId));
  await fs.mkdir(dir, { recursive: true });

  const filename = `${randomUUID()}.jpg`;
  const filePath = path.join(dir, filename);

  const processed = await sharp(src.buffer)
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  await fs.writeFile(filePath, processed.data);

  return {
    filename,
    size_bytes: processed.data.length,
    width: processed.info.width,
    height: processed.info.height,
    path: filePath,
  };
}

export function photoPath(
  dataDir: string,
  taskId: number,
  submissionId: number,
  filename: string,
): string {
  // Defensive: filename comes from the DB but never trust path traversals.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`refusing suspicious photo filename: ${filename}`);
  }
  return path.join(dataDir, "photos", String(taskId), String(submissionId), filename);
}
