import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { env } from '../config/env.js';

export const UPLOAD_ROOT = path.resolve(process.cwd(), env.uploadDir);
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

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

export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
    // random server-side names – never trust client file names on disk
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED[ext]?.includes(file.mimetype)) return cb(null, true);
    const err = new Error(`File type not allowed (${ext || file.mimetype})`);
    err.status = 400;
    cb(err, false);
  },
});
