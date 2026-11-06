import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './api';

export interface Opt { id: number; code?: string; name: string }
/** Loads dropdown options once per component. types = account type codes (120 customers, 210/211 vendors, 110 cash/bank ...). */
export function useAccounts(types: number[]) {
  const [rows, setRows] = useState<Opt[]>([]);
  useEffect(() => { api(`/accounting/lookup?types=${types.join(',')}`).then(setRows); }, [types.join(',')]);
  return rows;
}
export function useList(path: string) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api(path).then(setRows); }, [path]);
  return rows;
}
/** The user's own calendar date (YYYY-MM-DD). toISOString() is UTC, which is yesterday for the first hours of the day east of Greenwich. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => isoDate(new Date());

/** Lets the global "Create" menu deep-link to a page's create form (?new=1); the flag is consumed once. */
export function useOpenOnNew(open: () => void) {
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('new')) { open(); sp.delete('new'); setSp(sp, { replace: true }); } }, [sp]);
}

/** Where to see the record something refers to (a lead, quote, booking or client), or null when it isn't tied to one. */
export const recordPath = (type?: string | null, id?: number | null): string | null =>
  !type || !id ? null : ({ booking: `/bookings/${id}`, quote: `/quotes/${id}`, lead: `/leads?open=${id}`, client: `/clients?open=${id}` } as Record<string, string>)[type] ?? null;
