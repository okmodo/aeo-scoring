export function filterTelemetry(event) {
  const cpu = [event?.cpuTime, event?.cpuTimeMs, event?.$workers?.cpuTimeMs].find(value => typeof value === 'number' && Number.isFinite(value));
  let path;
  try { path = new URL(event?.event?.request?.url).pathname; } catch { /* No usable request path. */ }
  return { ...(cpu === undefined ? {} : { cpuMs: cpu }), ...(path ? { path } : {}) };
}
export function validCpu(event, maximum = Infinity) { return typeof event?.cpuMs === 'number' && Number.isFinite(event.cpuMs) && event.cpuMs >= 0 && event.cpuMs <= maximum; }

