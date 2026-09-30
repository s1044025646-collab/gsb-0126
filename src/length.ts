export const SCALE = 1000;

export function parseLength(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) throw new RangeError(`${field} must be non-negative`);
    return Math.round(value * SCALE);
  }
  if (typeof value === "string" && /^\d+(\.\d{1,3})?$/.test(value)) {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * SCALE + Number((fraction + "000").padEnd(3, "0"));
  }
  throw new RangeError(`${field} must be a non-negative number with at most 3 decimals`);
}

export function formatLength(microns: number): string {
  const whole = Math.floor(microns / SCALE);
  const fraction = Math.abs(microns % SCALE);
  return fraction === 0
    ? String(whole)
    : `${whole}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
}

export function positiveInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`${field} must be a positive integer`);
  return n;
}

export function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new RangeError(`${field} must be 1-64 letters, numbers, _ or -`);
  }
  return value;
}
