import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { AuthProvider, useAuth } from './auth';
import { ThemeProvider } from './theme';
import Layout from './components/Layout';
import Fallback from './components/Fallback';
import Login from './pages/Login';
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Invoices = lazy(() => import('./pages/Invoices'));
const Payments = lazy(() => import('./pages/Payments'));
const Commissions = lazy(() => import('./pages/Commissions'));
const Clients = lazy(() => import('./pages/Parties').then((m) => ({ default: m.Clients })));
const Suppliers = lazy(() => import('./pages/Parties').then((m) => ({ default: m.Suppliers })));
const Reports = lazy(() => import('./pages/Reports'));
const Recon = lazy(() => import('./pages/Recon'));
const Airlines = lazy(() => import('./pages/Airlines'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Ledger = lazy(() => import('./pages/Ledger'));
const CashBank = lazy(() => import('./pages/CashBank'));
const Journal = lazy(() => import('./pages/Journal'));
const Vouchers = lazy(() => import('./pages/Vouchers'));
const ChequeFormat = lazy(() => import('./pages/ChequeFormat'));
const SaleReports = lazy(() => import('./pages/SaleReports'));
const TicketInvoices = lazy(() => import('./pages/TicketInvoices'));
const Refunds = lazy(() => import('./pages/Refunds'));
const TicketSearch = lazy(() => import('./pages/TicketSearch'));
const Settings = lazy(() => import('./pages/Settings'));
const Audit = lazy(() => import('./pages/Audit'));
const Leads = lazy(() => import('./pages/Leads'));
const QuoteList = lazy(() => import('./pages/Quotes').then((m) => ({ default: m.QuoteList })));
const QuoteEditor = lazy(() => import('./pages/Quotes').then((m) => ({ default: m.QuoteEditor })));
const BookingList = lazy(() => import('./pages/Bookings').then((m) => ({ default: m.BookingList })));
const BookingWorkspace = lazy(() => import('./pages/Bookings').then((m) => ({ default: m.BookingWorkspace })));
const FinanceOverview = lazy(() => import('./pages/FinanceOverview'));
const ClientReceipts = lazy(() => import('./pages/ClientReceipts'));
const CreditNotes = lazy(() => import('./pages/CreditNotes'));
const SupplierBills = lazy(() => import('./pages/SupplierBills'));
const PaymentRuns = lazy(() => import('./pages/PaymentRuns'));
const Portal = lazy(() => import('./pages/Portal'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const ForgotPassword = lazy(() => import('./pages/ResetPassword').then((m) => ({ default: m.ForgotPassword })));
const ClientPortal = lazy(() => import('./pages/ClientPortal'));
const Automation = lazy(() => import('./pages/Automation'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Billing = lazy(() => import('./pages/Billing'));
const Team = lazy(() => import('./pages/Team'));
const ExchangeRates = lazy(() => import('./pages/ExchangeRates'));
const Statements = lazy(() => import('./pages/Statements'));
const Operations = lazy(() => import('./pages/Operations'));
const PublicQuote = lazy(() => import('./pages/PublicQuote'));
const Platform = lazy(() => import('./pages/Platform'));
const SupportEntry = lazy(() => import('./pages/Platform').then((m) => ({ default: m.SupportEntry })));
const AgencyAccessEntry = lazy(() => import('./pages/Platform').then((m) => ({ default: m.AgencyAccessEntry })));

function Guard() {
  const { user, ready, agencies } = useAuth();
  if (!ready) return <div className="min-h-screen grid place-items-center"><div className="h-8 w-8 rounded-full border-2 border-line border-t-accent animate-spin" role="status" aria-label="Loading" /></div>;
  if (user?.is_platform_admin && !agencies.length) return <Navigate to="/platform" replace />;   // operators without a workspace live in the console
  return user ? <Layout /> : <Navigate to="/login" replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider><BrowserRouter><AuthProvider><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/platform" element={<Suspense fallback={<Fallback />}><Platform /></Suspense>} />
    <Route path="/support" element={<Suspense fallback={<Fallback />}><SupportEntry /></Suspense>} />
    <Route path="/workspace-access" element={<Suspense fallback={<Fallback />}><AgencyAccessEntry /></Suspense>} />
    <Route path="/forgot-password" element={<Suspense fallback={<Fallback />}><ForgotPassword /></Suspense>} />
    <Route path="/reset-password/:token" element={<Suspense fallback={<Fallback />}><ResetPassword /></Suspense>} />
    <Route path="/portal/:token" element={<Suspense fallback={<Fallback />}><Portal /></Suspense>} />
    <Route path="/pay/:token" element={<Suspense fallback={<Fallback />}><Portal /></Suspense>} />
    <Route path="/q/:token" element={<Suspense fallback={<Fallback />}><PublicQuote /></Suspense>} />
    <Route element={<Guard />}>
      <Route index element={<Dashboard />} />
      <Route path="invoices" element={<Invoices />} />
      <Route path="payments" element={<Payments />} />
      <Route path="commissions" element={<Commissions />} />
      <Route path="clients" element={<Clients />} />
      <Route path="suppliers" element={<Suppliers />} />
      <Route path="reports" element={<Reports />} />
      <Route path="reconciliation" element={<Recon />} />
      <Route path="airlines" element={<Airlines />} />
      <Route path="accounts" element={<Accounts />} />
      <Route path="ledger" element={<Ledger />} />
      <Route path="cash-bank" element={<CashBank />} />
      <Route path="journal" element={<Journal />} />
      <Route path="receipts" element={<Vouchers kind="receipt" />} />
      <Route path="payment-vouchers" element={<Vouchers kind="payment" />} />
      <Route path="cheque-format" element={<ChequeFormat />} />
      <Route path="sale-reports" element={<SaleReports />} />
      <Route path="ticket-invoices" element={<TicketInvoices />} />
      <Route path="refunds" element={<Refunds />} />
      <Route path="ticket-search" element={<TicketSearch />} />
      <Route path="settings" element={<Settings />} />
      <Route path="audit" element={<Audit />} />
      <Route path="leads" element={<Leads />} />
      <Route path="quotes" element={<QuoteList />} />
      <Route path="quotes/:id" element={<QuoteEditor />} />
      <Route path="bookings" element={<BookingList />} />
      <Route path="bookings/:id" element={<BookingWorkspace />} />
      <Route path="operations" element={<Operations />} />
      <Route path="finance" element={<FinanceOverview />} />
      <Route path="client-receipts" element={<ClientReceipts />} />
      <Route path="credit-notes" element={<CreditNotes />} />
      <Route path="supplier-bills" element={<SupplierBills />} />
      <Route path="payment-runs" element={<PaymentRuns />} />
      <Route path="client-portal" element={<ClientPortal />} />
      <Route path="automation" element={<Automation />} />
      <Route path="integrations" element={<Integrations />} />
      <Route path="billing" element={<Billing />} />
      <Route path="team" element={<Team />} />
      <Route path="statements" element={<Statements />} />
      <Route path="exchange-rates" element={<ExchangeRates />} />
    </Route>
  </Routes></AuthProvider></BrowserRouter></ThemeProvider></React.StrictMode>,
);
