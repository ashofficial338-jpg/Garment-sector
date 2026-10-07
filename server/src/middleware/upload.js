import multer from 'multer';
import path from 'path';
import { env } from '../config/env.js';

const ALLOWED = {
  '.pdf': ['application/pdf'],
  '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc': ['application/msword'],
  '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'],
  '.txt': ['text/plain'],
};

/** Files are held in memory (size-limited) and then streamed into GridFS – nothing touches the local disk. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED[ext]?.includes(file.mimetype)) return cb(null, true);
    const err = new Error(`File type not allowed (${ext || file.mimetype})`);
    err.status = 400;
    cb(err, false);
  },
});
