// Fixed precision: all lengths are stored internally as integer micrometres (1 mm = 1000 um).

export const UM_PER_MM = 1000;

export function parseMmToUm(input: number | string, field: string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new ValidationError(`${field} must be a finite number`);
  } else if (typeof input === 'string') {
    if (!/^\d+(\.\d{1,3})?$/.test(input.trim())) {
      throw new ValidationError(`${field} must be a decimal string with at most 3 digits (mm)`);
    }
  } else {
    throw new ValidationError(`${field} must be a number or decimal string`);
  }
  const text = String(input).trim();
  const [whole, frac = ''] = text.split('.');
  const um = Number(whole) * UM_PER_MM + Number((frac + '000').slice(0, 3));
  if (um <= 0) throw new ValidationError(`${field} must be > 0`);
  return um;
}

export function umToMm(um: number): string {
  const whole = Math.floor(um / UM_PER_MM);
  const frac = um % UM_PER_MM;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
}

export class ValidationError extends Error {
  code = 'VALIDATION_ERROR';
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class DomainError extends Error {
 code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
    this.status = status;
  }
}
