import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Briefcase, CalendarClock, HelpCircle, Landmark, LifeBuoy, Lightbulb, LineChart, Rocket, Search, Settings, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth';
import { Page } from '../components/ui';

/** Who a topic is for. Everyone sees every topic; the badge says who can actually use the screen. */
type Who = 'everyone' | 'finance' | 'admin';
interface Topic { id: string; title: string; to?: string; who?: Who; about: string; steps?: string[]; tips?: string[] }
interface Section { id: string; title: string; icon: any; intro: string; topics: Topic[] }

const WHO: Record<Who, string> = { everyone: 'All roles', finance: 'Admin & Finance', admin: 'Admin only' };

const GUIDE: Section[] = [
  { id: 'start', title: 'Getting started', icon: Rocket, intro: 'Four steps from a new agency to your first paid invoice.', topics: [
    { id: 'first-sale', title: 'Your first sale in four steps', about: 'The dashboard shows a “Getting started” checklist until you have sent your first invoice. Each step opens the right screen.',
      steps: ['Add a client under Sales → Clients → New client.', 'Price the trip: Create → New quote. Add lines (flight, hotel, transfer…), set cost and mark-up, and send the quote link to the client.', 'When the client accepts, turn the quote into a booking.', 'Create an invoice from the booking, review it, send it, then record the payment when it arrives.'],
      tips: ['Everything you can create is also under the green Create button at the top of every page.', 'Press ⌘K (Ctrl+K on Windows) to search clients, invoices and tickets from anywhere.'] },
    { id: 'navigating', title: 'Finding your way around', about: 'The left menu is grouped by what you are doing: Overview, Sales, Finance & Accounting, Insights & Automation, and Administration. You only see the screens your role and plan allow.',
      tips: ['Click a menu group with an arrow to expand it.', 'The top bar has search, Create, a calculator, light/dark theme and your account menu.', 'The page title and short description under it always say what the screen is for.'] },
    { id: 'roles', title: 'Roles: who can do what', to: '/team', who: 'admin', about: 'Every person has one role per agency.',
      steps: ['Admin — everything, including settings, team, billing and the audit log.', 'Finance manager — all finance work and reports; cannot change agency settings or billing.', 'Agent — works on leads, quotes, bookings, clients and draft invoices. Cannot approve, issue, or see the ledger and finance reports. Sees their own ticket invoices.', 'Viewer — read-only.'],
      tips: ['If a menu item is missing, your role or your plan does not include it. Ask an Admin.'] },
  ] },
  { id: 'daily', title: 'Your day', icon: CalendarClock, intro: 'Where to start each morning.', topics: [
    { id: 'notifications', title: 'Notifications', to: '/notifications', about: 'The bell in the top bar counts what needs your attention: a client accepting or declining a quote, a payment arriving, an invoice going overdue or falling due, your tasks and lead follow-ups that are due, trips leaving within a week, replies from support and, for the owner, plan and limit warnings. Click one to jump to it. It is marked read as you go, and you can mark things read or unread yourself. Items clear on their own once the thing is dealt with, and what you see depends on your role.' },
    { id: 'dashboard', title: 'Dashboard', to: '/', about: 'The headline numbers (revenue, trips sold, what clients owe you, commission) with the change since last month, then what needs your attention and what is coming up in the next 14 days.',
      tips: ['Click any card or line to jump straight to the records behind it.', 'Money is shown in your agency’s base currency.'] },
    { id: 'operations', title: 'Operations: your daily list', to: '/operations', about: 'One list of follow-ups to make, tasks to finish, quotes about to expire, departures and passport checks, grouped as Overdue, Today, Tomorrow, Coming up and Later.',
      steps: ['Click a card at the top (Overdue, Due today…) to filter the list.', 'On a follow-up, press “Log follow-up”, say what happened and when to follow up next.', 'On a task, press Done, move it to another day with the clock, or edit it with the pencil.'],
      tips: ['Added a task by mistake? Use Undo in the banner right after you complete it.'] },
  ] },
  { id: 'sales', title: 'Sales & bookings', icon: Briefcase, intro: 'From first enquiry to the day the client gets home.', topics: [
    { id: 'leads', title: 'Leads', to: '/leads', about: 'People who have asked about a trip but have not booked. Move them through the stages and always set the next follow-up so nobody goes cold.',
      steps: ['New lead: Create → New lead.', 'Log each call or email and set the next follow-up date.', 'Turn a promising lead into a quote.'] },
    { id: 'quotes', title: 'Quotes', to: '/quotes', about: 'Price a trip, send it, and turn it into a booking once accepted. The client opens a secure link: they can accept, ask for changes or decline without an account.',
      steps: ['Create → New quote and add the client and trip lines.', 'Check the margin. If it falls below the agency’s minimum margin you are warned.', 'Send the quote. The link is shown once, so copy it if you need it again.', 'When it is accepted, convert it to a booking.'] },
    { id: 'bookings', title: 'Bookings', to: '/bookings', about: 'Every trip you sell. Click a booking to open its workspace: travellers, services and suppliers, itinerary, documents, invoices and payments in one place.',
      tips: ['“Departing in the next 7 days” appears on your dashboard and Operations list.', 'Supplier confirmations that are still missing are flagged for you.'] },
    { id: 'ticket-invoices', title: 'Ticket invoices', to: '/ticket-invoices', about: 'Airline tickets sold to clients, one card per passenger. A draft is not in your books until you issue it.',
      steps: ['Pick the client, then add each passenger’s ticket: airline, ticket number, route, fare, taxes and your service fee.', 'Fare breakdowns (tax codes, commissions, withholding) are one click away under “More”.', 'Press Issue (Admin or Finance). Issuing posts the invoice to the ledger.', 'Use “Client’s copy” to print or email the PDF. The client never sees your cost, commission or profit.'],
      tips: ['Edits to an issued invoice are re-posted automatically.', 'Agents can create drafts; only Admin or Finance can issue.'] },
    { id: 'refunds', title: 'Ticket refunds', to: '/refunds', about: 'Money going back to a client when a ticket is cancelled.',
      steps: ['Find the ticket by number, passenger or booking reference (or choose “This isn’t a ticket”).', 'Enter what the airline gives back and the fees you keep. What the client gets back is worked out for you.', 'Save. A pending refund is saved but stays out of the books until it is posted.'] },
    { id: 'ticket-search', title: 'Ticket search, airlines & sale reports', to: '/ticket-search', about: 'Search any ticket by number, passenger or booking reference; keep your airline list with their commission rates; and see what you sold and what you owe each airline.' },
    { id: 'visas', title: 'Visas', to: '/visas', about: 'Track every application from collecting documents to handing over the visa, and invoice the client when it is done. Late decisions are flagged so you can chase the embassy.' },
    { id: 'umrah', title: 'Umrah groups', to: '/umrah', about: 'Plan group departures, register pilgrims, and track every passport and visa until the group flies.' },
    { id: 'clients', title: 'Clients', to: '/clients', about: 'The people and companies you sell to. Open a client to see their trips, quotes, invoices, payments and statement together.',
      tips: ['Archive a client you no longer sell to; their history is kept and you can restore them.', 'Client portal: send a client a secure link to view quotes, invoices and itineraries and pay online.'] },
  ] },
  { id: 'finance', title: 'Finance & accounting', icon: Landmark, intro: 'Every receipt, payment, invoice and refund posts a balanced entry to the ledger. Posted entries are never edited — they are reversed.', topics: [
    { id: 'invoices', title: 'Invoices', to: '/invoices', about: 'Create an invoice, review it, send it, then record the payment. Issued invoices are never edited: credit them instead.',
      steps: ['Create → New invoice (or create one from a booking).', 'Review it, then Send. This issues it, posts it to the ledger and emails the client a PDF with a pay link.', 'Record payment when money arrives — or use Client receipts to spread one payment across several invoices.'],
      tips: ['An invoice that has already been sent keeps the exact PDF and design the client received.', 'Choose how your invoices look under Settings → Branding & invoices.'] },
    { id: 'receipts', title: 'Client receipts, cash receipts & payments received', to: '/client-receipts', who: 'finance', about: 'Money in from clients. A client receipt can be allocated across several invoices or kept as client credit. Voiding reverses the ledger entry; nothing is deleted.' },
    { id: 'credit-notes', title: 'Credit notes & refunds', to: '/credit-notes', who: 'finance', about: 'The correction for an issued invoice. Issue a credit note, then refund any overpayment. Amounts above the agency’s second-approver threshold need a different person to approve.' },
    { id: 'statements', title: 'Client statements', to: '/statements', who: 'finance', about: 'A client’s ledger account in base currency and what is still open.' },
    { id: 'suppliers', title: 'Suppliers & supplier bills', to: '/supplier-bills', who: 'finance', about: 'What you owe suppliers. Approving a bill posts it to the ledger; paying it clears the payable.',
      tips: ['A bill that is more than the tolerance over the booking cost is flagged (set the tolerance in Settings).'] },
    { id: 'payment-runs', title: 'Payment runs', to: '/payment-runs', who: 'finance', about: 'Pay approved supplier bills in batches.',
      steps: ['Pick the approved bills and press Validate (bank details and outstanding amounts are checked).', 'Submit the run. A different person must approve it (this can be switched off in Settings).', 'Export the bank file, pay in your bank, then confirm what the bank actually did. Nothing is marked paid before that.'] },
    { id: 'cash-bank', title: 'Cash & bank, reconciliation, cheques', to: '/cash-bank', who: 'finance', about: 'Your cash and bank accounts. Import a bank statement (CSV or OFX) under Bank reconciliation, auto-match it to the ledger, resolve the rest, then finalise to lock the statement. Cheque format controls how cheques print.' },
    { id: 'accounts', title: 'Accounts & ledger, journal, exchange rates', to: '/accounts', who: 'finance', about: 'The chart of accounts and each account’s ledger. Use Journal voucher for manual entries and Exchange rates to keep foreign-currency documents valid.',
      tips: ['Foreign-currency documents are refused if the exchange rate is older than the limit in Settings.', 'The accounting period lock (Settings → Financial controls) stops anything being posted on or before a date.'] },
    { id: 'commissions', title: 'Commissions', to: '/commissions', about: 'Agent commission by rule, with month-end approval (submit → approve → pay). Open any entry to see exactly how it was calculated.' },
  ] },
  { id: 'reports', title: 'Reports & automation', icon: LineChart, intro: 'The numbers behind the business, and the routine work that can run itself.', topics: [
    { id: 'reports', title: 'Reports', to: '/reports', who: 'finance', about: 'Start on the overview (this month against last, what is owed each way, cash in the bank), then open any report: Profit & Loss, Balance Sheet, Trial Balance, aging, sales by client or agent, tax summary, cash forecast and more.',
      steps: ['Pick a report and a date range (the presets cover this month, last month, this quarter, year to date).', 'Click a column heading to sort, type to filter, or click a row to drill into the records.', 'Download as PDF, Excel or CSV. Downloads carry every row and use the dates on screen.'],
      tips: ['A green or red bar says whether the report agrees with the ledger.', 'Press Schedule on a report to have it emailed to your team automatically.'] },
    { id: 'automation', title: 'Automation', to: '/automation', who: 'finance', about: 'What needs attention (overdue invoices, stuck payment runs, unanswered client requests), rules that act on it, and reports delivered on a schedule. Everything here is safe to re-run.' },
    { id: 'integrations', title: 'Integrations', to: '/integrations', who: 'finance', about: 'The public API, signed webhooks, accounting exports and CSV imports. Every connection can be inspected and revoked.' },
  ] },
  { id: 'admin', title: 'Administration', icon: Settings, intro: 'Set up your agency and look after your team.', topics: [
    { id: 'support', title: 'Getting help from support', to: '/support-center', about: 'Open Support in the Administration menu. It shows how to reach the team (email, phone, hours), whether the platform is running normally, and a form to send a question, a problem, a billing query or an idea. Replies appear on the same page and arrive by email. Admins also see who from the support team has access to the workspace right now and can end that access at any time; it is read-only and short-lived.' },
    { id: 'ai', title: 'AI assistant', about: 'Three helpers, all drafts you check before anything happens. On Quotes, “From an enquiry” turns a pasted email or WhatsApp message into a draft quote (it never sets prices). The sparkle button at the top asks questions about your own records — who is overdue, which trips leave soon — and writes client messages; on a client, “Write message” does the same for them. It appears only if your plan includes it and your platform administrator has switched it on.', to: '/quotes' },
    { id: 'settings', title: 'Agency settings', to: '/settings', about: 'Four tabs: Profile (name, address, tax number, time zone, invoice prefix), Branding & invoices (invoice design, logo, bank details), Financial controls (approvals, margin guardrail, commission rules, period lock) and Messaging (SMS). Changes are saved from the bar that appears at the bottom.' },
    { id: 'invoice-design', title: 'Choosing an invoice design', to: '/settings?tab=invoices', who: 'admin', about: 'Pick Classic, Modern, Minimal or Elegant. Previews use your own logo, address and bank details. The design you click becomes the default for booking invoices and ticket invoices.',
      tips: ['Use the “Ticket invoice” switch to preview that document too.', 'Already-sent invoices keep their original design.'] },
    { id: 'team', title: 'Team & branches', to: '/team', who: 'admin', about: 'Add people, give each a role, and place them in a branch. Removing someone ends their access at once and lets you hand their open work to a colleague. An agency always keeps at least one Admin.' },
    { id: 'billing', title: 'Billing', to: '/billing', who: 'admin', about: 'Your plan, usage against its limits, the plans you can switch to (upgrades apply immediately, downgrades at renewal) and your invoices.' },
    { id: 'audit', title: 'Audit log', to: '/audit', who: 'finance', about: 'A permanent record of who changed what and when. It cannot be edited.' },
  ] },
  { id: 'help', title: 'Tips & troubleshooting', icon: LifeBuoy, intro: 'Quick answers to common questions.', topics: [
    { id: 'tips', title: 'Time-savers', about: 'Small things that save a lot of clicks.', tips: ['⌘K / Ctrl+K searches everything.', 'The Create button starts any new document from any page.', 'Filters and tabs on most lists are kept in the web address, so you can bookmark or share a view.', 'The calculator in the top bar is always one click away.', 'Switch between light and dark with the moon icon.'] },
    { id: 'missing-menu', title: 'I can’t see a menu item', about: 'Menu items depend on your role and on your agency’s plan. Finance screens are hidden from agents and viewers. Ask an Admin to check your role under Team, or look at Billing to see what your plan includes.' },
    { id: 'locked', title: 'It says the period is locked', about: 'An Admin or Finance manager has locked accounting through a date. Nothing can be posted, edited or reversed on or before it. Ask them to reopen the period if a correction is genuinely needed.' },
    { id: 'rate', title: 'It says there is no exchange rate', about: 'Foreign-currency documents need a recent rate. Add one under Accounts → Exchange rates, or ask a Finance manager.' },
    { id: 'password', title: 'I forgot my password', about: 'Use “Forgot your password?” on the sign-in page. The link works once and expires in 30 minutes. If you do not receive it, ask your Admin to check that email sending is set up.' },
    { id: 'wrong-entry', title: 'I posted something by mistake', about: 'Posted entries are not edited or deleted. Void or reverse them (a receipt can be voided, an invoice credited, a journal reversed) and enter the correct one. The history stays visible in the audit log.' },
  ] },
];

const norm = (s: string) => s.toLowerCase();
const matches = (t: Topic, q: string) => !q || norm([t.title, t.about, ...(t.steps ?? []), ...(t.tips ?? [])].join(' ')).includes(q);

function TopicCard({ t }: { t: Topic }) {
  const nav = useNavigate();
  return (
    <article id={t.id} className="card scroll-mt-20">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold text-base">{t.title}</h3>
        <div className="flex items-center gap-2">{t.who && <span className="pill bg-surface2 text-muted">{WHO[t.who]}</span>}
          {t.to && <button className="btn-ghost !h-8 text-xs" onClick={() => nav(t.to!)}>Open <ArrowRight size={13} /></button>}</div>
      </div>
      <p className="text-sm text-muted mt-1.5 max-w-3xl leading-relaxed">{t.about}</p>
      {t.steps && <ol className="mt-3 space-y-2 text-sm max-w-3xl">{t.steps.map((s, i) => <li key={i} className="flex gap-3"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span><span>{s}</span></li>)}</ol>}
      {t.tips && <div className="mt-3 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2.5 max-w-3xl"><div className="flex items-center gap-1.5 text-xs font-semibold text-accent mb-1"><Lightbulb size={13} />Tips</div>
        <ul className="space-y-1 text-sm">{t.tips.map((s, i) => <li key={i} className="flex gap-2"><span className="text-accent">•</span><span>{s}</span></li>)}</ul></div>}
    </article>
  );
}

/** The in-app user guide: a searchable, always-up-to-date reference written around the real menus. */
export default function Help() {
  const [sp, setSp] = useSearchParams(); const { agency } = useAuth();
  const [q, setQ] = useState(sp.get('q') ?? ''); const query = norm(q.trim());
  const sections = useMemo(() => GUIDE.map((s) => ({ ...s, topics: s.topics.filter((t) => matches(t, query)) })).filter((s) => s.topics.length), [query]);
  const total = sections.reduce((n, s) => n + s.topics.length, 0);
  const [active, setActive] = useState(sections[0]?.id ?? '');
  useEffect(() => {
    if (query) return; const obs = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setActive(v.target.id.replace('sec-', '')); }, { rootMargin: '-80px 0px -65% 0px' });
    GUIDE.forEach((s) => { const el = document.getElementById(`sec-${s.id}`); if (el) obs.observe(el); }); return () => obs.disconnect();
  }, [query]);
  useEffect(() => { const h = location.hash.slice(1); if (h) setTimeout(() => document.getElementById(h)?.scrollIntoView({ block: 'start' }), 50); }, []);
  const jump = (id: string) => { document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const onQ = (v: string) => { setQ(v); setSp(v ? { q: v } : {}, { replace: true }); };

  return (
    <Page title="User guide" description={<>How to use Travel CRM{agency ? ` for ${agency.name}` : ''}, step by step.</>}>
      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start space-y-3">
          <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" /><input className="input pl-8" type="search" placeholder="Search the guide…" aria-label="Search the guide" value={q} onChange={(e) => onQ(e.target.value)} /></div>
          <nav aria-label="Guide sections" className="hidden lg:block space-y-0.5">
            {sections.map((s) => { const I = s.icon; return (
              <button key={s.id} onClick={() => jump(s.id)} className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${!query && active === s.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:bg-surface2 hover:text-fg'}`}><I size={16} className="shrink-0" />{s.title}<span className="ml-auto text-xs opacity-60 num">{s.topics.length}</span></button>); })}
          </nav>
          <div className="flex gap-2 overflow-x-auto lg:hidden pb-1" role="group" aria-label="Jump to section">{sections.map((s) => <button key={s.id} className="btn-ghost !h-8 text-xs shrink-0" onClick={() => jump(s.id)}>{s.title}</button>)}</div>
        </aside>

        <div className="min-w-0 space-y-10">
          {query && <p className="text-sm text-muted">{total ? `${total} topic${total === 1 ? '' : 's'} match “${q.trim()}”.` : ''}</p>}
          {!sections.length && <div className="card text-center py-14"><HelpCircle size={28} className="mx-auto text-muted mb-2" /><div className="font-medium">Nothing in the guide matches “{q.trim()}”</div><p className="text-sm text-muted mt-1">Try a simpler word, such as “invoice”, “refund” or “team”.</p><button className="btn-ghost mt-4" onClick={() => onQ('')}>Clear search</button></div>}
          {sections.map((s) => { const I = s.icon; return (
            <section key={s.id} id={`sec-${s.id}`} className="scroll-mt-20" aria-labelledby={`h-${s.id}`}>
              <div className="flex items-center gap-3 mb-4"><span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><I size={20} /></span><div><h2 id={`h-${s.id}`} className="text-xl font-semibold">{s.title}</h2><p className="text-sm text-muted">{s.intro}</p></div></div>
              <div className="space-y-3">{s.topics.map((t) => <TopicCard key={t.id} t={t} />)}</div>
            </section>); })}
          {!query && <div className="card flex flex-wrap items-center gap-3 bg-surface2/50"><ShieldCheck size={18} className="text-accent" /><p className="text-sm flex-1 min-w-[14rem]">Still stuck? Ask an Admin in your agency, or contact the platform operator who set up your account.</p></div>}
        </div>
      </div>
    </Page>
  );
}
