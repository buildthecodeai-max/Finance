import { useEffect, useId, useState } from 'react';

/** Client picker: type to search, pick from the list. Duplicate names get "(#id)" so they can be told apart. Calls onChange('') while the text matches no client. */
export function ClientPick({ clients, value, onChange, autoFocus, disabled, placeholder = 'Start typing a client name…' }:
  { clients: any[]; value: string | number; onChange(id: string): void; autoFocus?: boolean; disabled?: boolean; placeholder?: string }) {
  const listId = useId();
  const label = (c: any) => (clients.filter((x) => x.name.toLowerCase() === c.name.toLowerCase()).length > 1 ? `${c.name} (#${c.id})` : c.name);
  const [text, setText] = useState('');
  useEffect(() => { const c = clients.find((x) => String(x.id) === String(value)); if (c && label(c) !== text) setText(label(c)); }, [value, clients]);
  const pick = (t: string) => { setText(t); const c = clients.find((x) => label(x).toLowerCase() === t.trim().toLowerCase()); onChange(c ? String(c.id) : ''); };
  return <><input className="input" list={listId} placeholder={placeholder} value={text} autoFocus={autoFocus} disabled={disabled} onChange={(e) => pick(e.target.value)} />
    <datalist id={listId}>{clients.map((c) => <option key={c.id} value={label(c)} />)}</datalist></>;
}
