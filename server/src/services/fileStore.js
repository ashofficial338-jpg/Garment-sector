/**
 * Document file storage in MongoDB GridFS.
 * Works on hosts with ephemeral disks (Render, containers) – files live with the data.
 */
import mongoose from 'mongoose';
import { Readable } from 'stream';

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });

/** Store a buffer; returns the GridFS file id (string). */
export function saveFile(buffer, { filename, contentType, metadata } = {}) {
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(filename, { metadata: { contentType, ...metadata } });
    Readable.from(buffer).pipe(up).on('error', reject).on('finish', () => resolve(String(up.id)));
  });
}

export async function fileExists(id) {
  if (!mongoose.isValidObjectId(id)) return false;
  return !!(await bucket().find({ _id: new mongoose.Types.ObjectId(id) }).limit(1).next());
}

export function openFile(id) {
  return bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
}

export async function removeFile(id) {
  if (!mongoose.isValidObjectId(id)) return;
  await bucket().delete(new mongoose.Types.ObjectId(id)).catch(() => {});
}
