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
export const today = () => new Date().toISOString().slice(0, 10);

/** Lets the global "Create" menu deep-link to a page's create form (?new=1); the flag is consumed once. */
export function useOpenOnNew(open: () => void) {
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('new')) { open(); sp.delete('new'); setSp(sp, { replace: true }); } }, [sp]);
}
