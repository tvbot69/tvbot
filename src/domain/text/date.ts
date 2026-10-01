export function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}
