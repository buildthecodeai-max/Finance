import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { nextDocNo } from './accounting.js';
import { emit } from './webhooks.js';

/** Minimal RFC 4180 parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export interface ImportRow { line: number; external_ref: string; status: 'ok' | 'duplicate' | 'error'; message?: string; client_id?: number; data?: Record<string, any>; new_client?: { name: string; email: string | null } }
const STATUSES = ['confirmed', 'in_service', 'travel_completed', 'closed', 'on_hold', 'cancelled'];
export const validDate = (v: string) => { const d = new Date(`${v}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };
const REQUIRED = ['external_ref', 'destination', 'travel_start'];
export const SOURCE = 'csv';

/** Generic booking-CSV adapter: external_ref, client_email|client_name, destination, travel_start, travel_end, status, currency. */
export async function previewBookings(t: Tenant, text: string, createClients: boolean) {
  if (text.length > 1_000_000) throw new HttpError(413, 'File too large (1 MB max)');
  const table = parseCsv(text); if (table.length < 2) throw new HttpError(400, 'The file needs a header row and at least one booking');
  if (table.length > 501) throw new HttpError(413, 'At most 500 bookings per import');
  const head = table[0].map((h) => h.trim().toLowerCase()), miss = REQUIRED.filter((c) => !head.includes(c));
  if (miss.length) throw new HttpError(400, `Missing column(s): ${miss.join(', ')}`);
  if (!head.includes('client_email') && !head.includes('client_name')) throw new HttpError(400, 'Include a client_email or client_name column');
  const get = (r: string[], k: string) => (r[head.indexOf(k)] ?? '').trim();
  const out: ImportRow[] = [], seen = new Set<string>(), agency = await t.agency();
  for (let i = 1; i < table.length; i++) {
    const r = table[i], ref = get(r, 'external_ref').slice(0, 80), line = i + 1, err = (message: string): ImportRow => ({ line, external_ref: ref, status: 'error', message });
    if (!ref) { out.push(err('external_ref is required')); continue; }
    if (seen.has(ref)) { out.push(err('duplicate external_ref inside this file')); continue; } seen.add(ref);
    if (await t.one('SELECT id FROM bookings WHERE agency_id = ? AND external_source = ? AND external_ref = ?', [t.agencyId, SOURCE, ref])) { out.push({ line, external_ref: ref, status: 'duplicate', message: 'already imported' }); continue; }
    const start = get(r, 'travel_start'), end = get(r, 'travel_end') || null, status = (get(r, 'status') || 'confirmed').toLowerCase(), cur = (get(r, 'currency') || agency.base_currency).toUpperCase();
    if (!validDate(start) || (end && !validDate(end))) { out.push(err('dates must be YYYY-MM-DD')); continue; }
    if (end && end < start) { out.push(err('travel_end is before travel_start')); continue; }
    if (!STATUSES.includes(status)) { out.push(err(`status must be one of ${STATUSES.join(', ')}`)); continue; }
    if (!/^[A-Z]{3}$/.test(cur)) { out.push(err('currency must be a 3-letter code')); continue; }
    const email = head.includes('client_email') ? get(r, 'client_email').toLowerCase() : '', name = head.includes('client_name') ? get(r, 'client_name') : '';
    let client = email ? await t.one('SELECT id FROM clients WHERE agency_id = ? AND LOWER(email) = ? ORDER BY id LIMIT 1', [t.agencyId, email]) : undefined;
    if (!client && !email && name) { const m = await t.query('SELECT id FROM clients WHERE agency_id = ? AND LOWER(name) = ? LIMIT 2', [t.agencyId, name.toLowerCase()]); if (m.length > 1) { out.push(err(`client name "${name}" is ambiguous — use client_email`)); continue; } client = m[0]; }
    const data = { destination: get(r, 'destination').slice(0, 120), travel_start: start, travel_end: end, status, currency: cur };
    if (client) out.push({ line, external_ref: ref, status: 'ok', client_id: client.id, data });
    else if (createClients && (name || email)) out.push({ line, external_ref: ref, status: 'ok', data, new_client: { name: name || email, email: email || null } });
    else out.push(err('client not found (enable "create missing clients" or fix the email/name)'));
  }
  return out;
}

export async function commitBookings(t: Tenant, rows: ImportRow[]) {
  const ok = rows.filter((r) => r.status === 'ok'), created: number[] = [];
  await t.tx(async (tx) => {
    const made = new Map<string, number>();
    for (const r of ok) {
      let clientId = r.client_id;
      if (!clientId) {
        const key = (r.new_client!.email ?? r.new_client!.name).toLowerCase();
        if (!made.has(key)) made.set(key, await tx.insert('clients', { name: r.new_client!.name, email: r.new_client!.email, currency: r.data!.currency }));
        clientId = made.get(key)!;
      }
      const reference = await nextDocNo(tx, 'bookings', 'reference', 'BK');
      const id = await tx.insert('bookings', { ...r.data, client_id: clientId, reference, external_source: SOURCE, external_ref: r.external_ref });
      await tx.insert('activities', { entity_type: 'booking', entity_id: id, kind: 'system', body: `Imported from CSV (${r.external_ref})`, created_by: tx.actor.userId });
      await emit(tx, 'booking.imported', { booking_id: id, reference, external_ref: r.external_ref, client_id: clientId });
      created.push(id);
    }
  });
  return created;
}
