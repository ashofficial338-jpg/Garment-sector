/* Minimal structured logger (swap for pino/winston in production if desired). */
const ts = () => new Date().toISOString();
export const logger = {
  info: (...a) => console.log(`[${ts()}] INFO`, ...a),
  warn: (...a) => console.warn(`[${ts()}] WARN`, ...a),
  error: (...a) => console.error(`[${ts()}] ERROR`, ...a),
};
