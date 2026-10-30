import type { Request } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors.js';

export const T = (req: Request) => req.tenant!;
export const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
};
export const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad id');
  return id;
};
export const csvEscape = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (cols: string[], rows: any[][]) =>
  [cols, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
