export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineIn {
  product_type: 'flight' | 'hotel' | 'package' | 'cruise' | 'transfer' | 'other';
  supplier_id?: number | null;
  description: string;
  quantity: number;
  unit_cost: number;
  markup_pct: number;
  tax_rate: number;
}

/** selling price = cost * (1 + markup%); tax (GST/VAT) applies on the marked-up net. */
export function priceLines(lines: LineIn[]) {
  let subtotal = 0, tax = 0;
  const out = lines.map((l) => {
    const unit_price = r2(l.unit_cost * (1 + l.markup_pct / 100));
    const line_net = r2(unit_price * l.quantity);
    const line_tax = r2(line_net * (l.tax_rate / 100));
    subtotal += line_net; tax += line_tax;
    return { ...l, supplier_id: l.supplier_id ?? null, unit_price, line_net, line_tax };
  });
  return { lines: out, subtotal: r2(subtotal), tax_total: r2(tax), total: r2(subtotal + tax) };
}

export const addDays = (d: string | Date, n: number) => {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};
export const today = () => new Date().toISOString().slice(0, 10);
export const fmt = (n: number, cur: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(n);
