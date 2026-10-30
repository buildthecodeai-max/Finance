import { useState } from 'react';
import { Delete } from 'lucide-react';
import { Modal } from './ui';

export default function Calculator({ onClose }: { onClose(): void }) {
  const [expr, setExpr] = useState('');
  const press = (k: string) => {
    if (k === 'C') return setExpr('');
    if (k === '⌫') return setExpr(expr.slice(0, -1));
    if (k === '=') {
      try { // only digits and operators reach this, so evaluating via Function is safe here
        if (!/^[\d+\-*/.() ]+$/.test(expr)) return;
        setExpr(String(Math.round(Function(`"use strict";return (${expr})`)() * 1e8) / 1e8));
      } catch { setExpr('Error'); }
      return;
    }
    setExpr((expr === 'Error' ? '' : expr) + k);
  };
  const op = (k: string) => ['/', '*', '-', '+'].includes(k);
  return (
    <Modal title="Calculator" onClose={onClose}>
      <div className="max-w-xs mx-auto">
        <input aria-label="Expression" className="input num !h-14 text-right !text-2xl mb-3" value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && press('=')} autoFocus />
        <div className="grid grid-cols-4 gap-2">{['C', '(', ')', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '⌫', '='].map((k) => (
          <button key={k} onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k} className={`h-12 rounded-xl text-base font-medium transition ${k === '=' ? 'bg-accent text-accent-ink hover:brightness-110' : op(k) ? 'bg-accent/10 text-accent hover:bg-accent/20' : 'bg-surface2 hover:bg-line/60'}`}>{k === '⌫' ? <Delete size={18} className="mx-auto" /> : k}</button>))}</div>
      </div>
    </Modal>
  );
}
