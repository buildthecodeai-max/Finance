import { r2 } from './money.js';

export interface PriceIn { quantity: number; unit_cost: number; markup_pct: number; discount_pct: number; tax_rate: number }

/**
 * Component pricing:  unit_price = cost × (1 + markup%);  net = unit_price × qty × (1 − discount%);  tax = net × tax%.
 * Tax applies to the discounted selling net. Cost is never taxed here (supplier tax is out of scope for R2).
 */
export function priceComponent(c: PriceIn) {
  const unit_price = r2(c.unit_cost * (1 + c.markup_pct / 100));
  const net_total = r2(unit_price * c.quantity * (1 - c.discount_pct / 100));
  return { unit_price, net_total, tax_total: r2(net_total * (c.tax_rate / 100)), cost_total: r2(c.unit_cost * c.quantity) };
}

/** Margin on selling net, as a percentage. Returns null when there is nothing sold (avoids fake 0%/NaN). */
export const marginPct = (net: number, cost: number): number | null => (net > 0 ? r2(((net - cost) / net) * 100) : null);
