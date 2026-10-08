/**
 * Renders any module form from its shared definition, with live calculations
 * (the same compute() the server uses authoritatively).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Field, Icon } from './ui.jsx';
import { fmtSmart, toInputDate } from '../utils/format.js';

/* --------------------------- Async reference select --------------------------- */
export function RefSelect({ refModel, value, onChange, disabled, params, placeholder, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [label, setLabel] = useState('');
  const box = useRef(null);
  const id = value && typeof value === 'object' ? value._id : value;

  useEffect(() => {
    if (value && typeof value === 'object') setLabel(value.label || value.name || value.refNo || value.jobNo || '');
    else if (id && !label) {
      api.get(`/lookup/${refModel}`, { params: { id } }).then((r) => setLabel(r.data[0]?.label || '')).catch(() => {});
    } else if (!id) setLabel('');
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      api.get(`/lookup/${refModel}`, { params: { q, ...params } }).then((r) => setItems(r.data)).catch(() => setItems([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open, refModel, JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input
        value={open ? q : label}
        placeholder={placeholder || `Search ${refModel}…`}
        disabled={disabled}
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={(e) => setQ(e.target.value)}
      />
      {id && !disabled && (
        <button type="button" className="btn btn-ghost btn-icon btn-sm" style={{ position: 'absolute', right: 3, top: 3 }} onClick={() => { onChange(null); setLabel(''); }} aria-label="Clear">
          <Icon name="X" size={14} />
        </button>
      )}
      {open && (
        <div className="search-pop" style={{ top: 40, zIndex: 20 }}>
          {items.length === 0 && <div className="muted small" style={{ padding: 10 }}>No matches</div>}
          {items.map((it) => (
            <div key={it._id} className="search-item" onMouseDown={() => { onChange(it._id); setLabel(it.label); setOpen(false); onPick?.(it); }}>
              <div><div className="t">{it.label}</div>{it.status && <div className="s">{it.status}</div>}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TagsInput({ value = [], onChange, disabled }) {
  const [t, setT] = useState('');
  const add = () => { const v = t.trim(); if (v && !value.includes(v)) onChange([...value, v]); setT(''); };
  return (
    <div className="tags-input">
      {value.map((x) => (
        <span key={x} className="chip">{x}{!disabled && <Icon name="X" size={12} style={{ cursor: 'pointer' }} onClick={() => onChange(value.filter((y) => y !== x))} />}</span>
      ))}
      {!disabled && <input value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} placeholder="Type & Enter" />}
    </div>
  );
}

/* --------------------------- Single input --------------------------- */
export function FieldInput({ f, value, onChange, disabled, params }) {
  if (f.readOnly) {
    const show = f.type === 'date' ? toInputDate(value) : f.type === 'number' ? (value === null || value === undefined || value === '' ? '' : fmtSmart(value)) : value ?? '';
    return <input className="calc" readOnly value={show} tabIndex={-1} />;
  }
  switch (f.type) {
    case 'textarea': return <textarea value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case 'number': return <input type="number" step="any" min={f.min} max={f.max} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value)} />;
    case 'date': return <input type="date" value={toInputDate(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case 'select': return (
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
    case 'boolean': return <label className="check"><input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {f.label}</label>;
    case 'ref': return <RefSelect refModel={f.ref} value={value} onChange={onChange} disabled={disabled} params={params} />;
    case 'tags': return <TagsInput value={value || []} onChange={onChange} disabled={disabled} />;
    default: return <input value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}

/* --------------------------- Editable sub-table --------------------------- */
export function TableField({ f, value = [], onChange, disabled, errors = {} }) {
  const rows = Array.isArray(value) ? value : [];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const STATE = { completed: ['green', 'Completed'], delayed: ['red', 'Delayed'], inProgress: ['amber', 'In Progress'], notStarted: ['grey', 'Not Started'] };
  return (
    <div>
      <div className="subtable">
        <table>
          <thead><tr>{f.fields.map((sf) => <th key={sf.name}>{sf.label}</th>)}{!disabled && <th />}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={f.fields.length + 1} className="muted small" style={{ padding: 12 }}>No rows</td></tr>}
            {rows.map((r, i) => (
              <tr key={r._id || i}>
                {f.fields.map((sf) => (
                  sf.readOnly ? (
                    <td key={sf.name} className="calc-cell">
                      {sf.name === 'state' && STATE[r.state] ? <span className={`badge b-${STATE[r.state][0]}`}>{STATE[r.state][1]}</span> : fmtSmart(r[sf.name] ?? '')}
                    </td>
                  ) : (
                    <td key={sf.name} style={errors[`${f.name}.${i}.${sf.name}`] ? { background: 'var(--red-50)' } : undefined}>
                      <FieldInput f={sf} value={r[sf.name]} disabled={disabled} onChange={(v) => set(i, sf.name, v)} />
                    </td>
                  )
                ))}
                {!disabled && (
                  <td style={{ width: 36 }}>
                    <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row"><Icon name="Trash2" size={14} /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <button type="button" className="btn btn-sm mt" onClick={() => onChange([...rows, Object.fromEntries(f.fields.filter((x) => x.default !== undefined).map((x) => [x.name, x.default]))])}>
          <Icon name="Plus" size={14} /> Add row
        </button>
      )}
    </div>
  );
}

/* --------------------------- Whole form --------------------------- */
export function FormRenderer({ def, values, onChange, errors = {}, disabled, hide = [], jobNo }) {
  const sections = useMemo(() => {
    const out = [];
    let cur = { title: null, fields: [] };
    def.fields.forEach((f) => {
      if (hide.includes(f.name)) return;
      if (f.section && cur.fields.length) { out.push(cur); cur = { title: f.section, fields: [] }; } else if (f.section) cur.title = f.section;
      cur.fields.push(f);
    });
    if (cur.fields.length) out.push(cur);
    return out;
  }, [def, hide]);

  return (
    <div>
      {sections.map((s, si) => (
        <div key={si} className={si ? 'form-section' : ''}>
          {s.title && <div className="form-section-title">{s.title}</div>}
          <div className="form-grid">
            {s.fields.map((f) => (
              f.type === 'table' ? (
                <div key={f.name} className="span-2">
                  <div className="field"><label>{f.label}</label>{f.hint && <div className="muted small">{f.hint}</div>}</div>
                  <TableField f={f} value={values[f.name]} disabled={disabled} errors={errors} onChange={(v) => onChange(f.name, v)} />
                </div>
              ) : (
                <Field key={f.name} label={f.type === 'boolean' ? '' : f.label} required={f.required && !f.readOnly} error={errors[f.name]} hint={f.hint} span={f.span === 2}>
                  <FieldInput f={f} value={values[f.name]} disabled={disabled} onChange={(v) => onChange(f.name, v)} params={f.jobScoped && jobNo ? { job: jobNo } : undefined} />
                </Field>
              )
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
