import { getFile } from '../storage.js';
import { css, esc } from './pdf.js';

/** Service voucher kinds: the title, number prefix and wording that fits the product being supplied. */
const KINDS: Record<string, { title: string; prefix: string; qty: string; start: string; end: string }> = {
  hotel: { title: 'Hotel Voucher', prefix: 'HV', qty: 'Rooms', start: 'Check-in', end: 'Check-out' },
  car: { title: 'Car Rental Voucher', prefix: 'CV', qty: 'Vehicles', start: 'Pick-up', end: 'Drop-off' },
  transfer: { title: 'Transfer Voucher', prefix: 'TV', qty: 'Vehicles', start: 'Date', end: 'Return' },
  tour: { title: 'Tour Voucher', prefix: 'SV', qty: 'Guests', start: 'Starts', end: 'Ends' },
  package: { title: 'Package Voucher', prefix: 'PV', qty: 'Guests', start: 'From', end: 'To' },
  cruise: { title: 'Cruise Voucher', prefix: 'SV', qty: 'Cabins', start: 'Embark', end: 'Disembark' },
};
const OTHER = { title: 'Service Voucher', prefix: 'SV', qty: 'Quantity', start: 'From', end: 'To' };
export const voucherKind = (productType: string) => KINDS[productType] ?? OTHER;
export const voucherNo = (productType: string, bookingRef: string, componentId: number) => `${voucherKind(productType).prefix}-${bookingRef}-${componentId}`;

export async function agencyLogoData(agency: any): Promise<{ data: string; mime: string } | null> {
  if (!agency.logo_key) return null;
  try {
    const buf = await getFile(agency.logo_key);
    const ext = agency.logo_key.split('.').pop()?.toLowerCase() ?? '';
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { data: buf.toString('base64'), mime };
  } catch { return null; }
}

const d10 = (d: unknown) => (d ? String(d).slice(0, 10) : '');
const nights = (a: unknown, b: unknown) => (a && b ? Math.max(0, Math.round((Date.parse(d10(b)) - Date.parse(d10(a))) / 864e5)) : null);

/** A voucher carries no prices: it is the proof of booking handed to the guest or the supplier. */
export function voucherHtml(a: any, b: any, c: any, supplier: any, guests: any[], client: any, logo: { data: string; mime: string } | null) {
  const k = voucherKind(c.product_type), no = voucherNo(c.product_type, b.reference, c.id), confirmed = c.confirmation_status === 'confirmed';
  const n = nights(c.service_start, c.service_end), qty = Number(c.quantity);
  const logoImg = logo ? `<img src="data:${logo.mime};base64,${logo.data}" style="max-height:64px;max-width:200px;object-fit:contain;display:block;margin-bottom:6px" alt="logo">` : '';
  const row = (l: string, v: unknown) => (v === null || v === undefined || v === '' ? '' : `<tr><td class="m" style="width:34%;padding:6px 0">${esc(l)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`);
  const names = guests.length ? guests.map((g) => `${g.first_name} ${g.last_name}`) : [client?.name ?? ''];
  return `<html><head><meta charset="utf-8"><style>${css}
.v-ttl{font-size:26px}.box{border:1px solid #e3e7ee;border-radius:8px;padding:10px 16px;margin-bottom:14px;page-break-inside:avoid}
.guest{display:inline-block;background:#f1f4f8;border-radius:5px;padding:3px 9px;margin:0 6px 6px 0;font-weight:600}
.prov{background:#fdf0d5;color:#9a5b00}.conf{background:#d9f5ea;color:#067a55}</style></head><body>
  <div class="bar"></div>
  <div class="top"><div>${logoImg}<div class="brand">${esc(a.name)}</div><div class="addr">${esc(a.address ?? '')}</div></div>
    <div style="text-align:right"><h1 class="v-ttl">${esc(k.title.toUpperCase())}</h1><div style="margin:6px 0 8px;font-size:13px;font-weight:600">${esc(no)}</div>
      <span class="badge ${confirmed ? 'conf' : 'prov'}">${confirmed ? 'Confirmed' : 'Provisional — awaiting supplier confirmation'}</span></div></div>
  <div class="meta"><div><div class="lbl">Booking</div><div class="val">${esc(b.reference)}</div></div>
    <div><div class="lbl">Issued</div><div class="val">${esc(new Date().toISOString().slice(0, 10))}</div></div>
    <div><div class="lbl">Supplier confirmation no.</div><div class="val">${esc(c.supplier_ref || '—')}</div></div></div>
  <h3>Guests</h3><div>${names.filter(Boolean).map((x) => `<span class="guest">${esc(x)}</span>`).join('')}</div>
  <h3>Service</h3><div class="box"><table>
    ${row('Provided by', supplier?.name)}${row('Service', c.description)}
    ${row(k.start, d10(c.service_start))}${row(k.end, d10(c.service_end))}${n !== null && n > 0 ? row('Duration', `${n} night${n === 1 ? '' : 's'}`) : ''}
    ${row(k.qty, qty ? String(qty) : '')}${row('Destination', b.destination)}</table></div>
  ${c.cancellation_terms ? `<h3>Cancellation terms</h3><div class="note">${esc(c.cancellation_terms)}</div>` : ''}
  <div class="thanks">Please present this voucher on arrival. Issued by ${esc(a.name)}.${confirmed ? '' : ' This voucher is provisional until the supplier confirms.'}</div>
  </body></html>`;
}
