// Only the private validation wrappers retain these bounded provider diagnostics.
export function privateProviderError(error) {
  const details = {};
  for (const key of ['name', 'code', 'message']) {
    const value = error?.[key];
    if (typeof value === 'string') details[key] = value.slice(0, 2048);
    else if (key === 'code' && typeof value === 'number' && Number.isFinite(value)) details[key] = value;
  }
  return details;
}
