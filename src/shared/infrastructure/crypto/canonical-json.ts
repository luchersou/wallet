/** JSON with recursively sorted keys; undefined is omitted (JSON semantics). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) acc[key] = sortKeys(v);
        return acc;
      }, {});
  }
  return value;
}