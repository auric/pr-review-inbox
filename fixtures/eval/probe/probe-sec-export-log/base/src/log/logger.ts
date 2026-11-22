// Writes one JSON line per event. The log shipper sends each line to the shared log store, where support staff read it.
const write = (level: string, msg: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...data }));

export const log = {
  info: (msg: string, data: Record<string, unknown> = {}) => write("info", msg, data),
  warn: (msg: string, data: Record<string, unknown> = {}) => write("warn", msg, data),
  error: (msg: string, data: Record<string, unknown> = {}) => write("error", msg, data),
};
