/** After the app has settled, quietly fetch the other screens so a tab click never waits on a download. */
const screens = [
  () => import('./pages/Dashboard'), () => import('./pages/Leads'), () => import('./pages/Quotes'), () => import('./pages/Bookings'), () => import('./pages/Parties'),
  () => import('./pages/Invoices'), () => import('./pages/Payments'), () => import('./pages/FinanceOverview'), () => import('./pages/Operations'), () => import('./pages/Reports'),
  () => import('./pages/CashBank'), () => import('./pages/Accounts'), () => import('./pages/Settings'), () => import('./pages/Team'), () => import('./pages/Billing'),
  () => import('./pages/Commissions'), () => import('./pages/Visas'), () => import('./pages/Umrah'), () => import('./pages/Automation'), () => import('./pages/Integrations'),
  () => import('./pages/Notifications'), () => import('./pages/Support'), () => import('./pages/ClientPortal'), () => import('./pages/Audit'), () => import('./pages/Help'),
];
let started = false;
export function preloadScreens() {
  if (started) return; started = true;
  const idle: (cb: () => void) => void = (window as any).requestIdleCallback ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 3000 }) : (cb) => setTimeout(cb, 1500);
  let i = 0; const next = () => { if (i >= screens.length) return; screens[i++]().catch(() => {}); idle(next); };   // one at a time, only when the browser is idle
  setTimeout(() => idle(next), 1500);
}
