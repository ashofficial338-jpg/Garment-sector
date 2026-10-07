/** Centralised Report Center: filters + View / PDF / Excel / CSV / Print. */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errMsg, download } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Icon, Card, Empty, Spinner, Field } from '../components/ui.jsx';
import { DEPARTMENTS } from '@shared/constants.js';
import { MODULES } from '@shared/modules/index.js';
import { reportPdf } from '../utils/pdf.js';
import { fmtDate, fmtNum } from '../utils/format.js';

const show = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return fmtNum(v, Number.isInteger(v) ? 0 : 2);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDate(v);
  if (typeof v === 'object') return v.name || v.refNo || v.jobNo || '';
  return String(v);
};

export default function Reports() {
  const { can } = useAuth();
  const { toast } = useFeedback();
  const [sp] = useSearchParams();
  const [list, setList] = useState([]);
  const [key, setKey] = useState(sp.get('r') || '');
  const [f, setF] = useState({ from: '', to: '', job: '', buyer: '', department: '', status: '', createdBy: '' });
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => { api.get('/reports').then((r) => { setList(r.data); if (!key && r.data[0]) setKey(r.data[0].key); }).catch((e) => toast(errMsg(e), 'err')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rep = list.find((x) => x.key === key);
  const params = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f]);
  const run = async () => {
    if (!key) return;
    setBusy(true);
    try { setData((await api.get(`/reports/${key}`, { params })).data); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  useEffect(() => { setData(null); if (key) run(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterText = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join(' · ');
  const groups = list.reduce((m, r) => ({ ...m, [r.department]: [...(m[r.department] || []), r] }), {});
  const statuses = rep ? MODULES[rep.module]?.statuses || [] : [];

  return (
    <div>
      <PageHead title="Report Center" icon="FileBarChart" subtitle="Every module report with date, job, buyer, department, status and user filters – export to PDF, Excel, CSV or print." />
      <div className="grid mt side-grid">
        <Card title="Reports" icon="Files" pad={false} className="hide-sm">
          <div style={{ padding: 10 }}><input placeholder="Find report…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '0 8px 10px' }}>
            {Object.entries(groups).map(([dept, reps]) => {
              const items = reps.filter((r) => r.title.toLowerCase().includes(q.toLowerCase()));
              if (!items.length) return null;
              return (
                <div key={dept} className="mb">
                  <div className="nav-group-title" style={{ color: 'var(--muted)' }}>{dept}</div>
                  {items.map((r) => (
                    <div key={r.key} className={`search-item ${r.key === key ? 'on' : ''}`} onClick={() => setKey(r.key)}><Icon name="FileText" size={15} /> {r.title}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </Card>
        <div className="col">
          <Card title={rep?.title || 'Select a report'} icon="SlidersHorizontal">
            <div className="form-grid">
              <Field label="Report" ><select value={key} onChange={(e) => setKey(e.target.value)}>{list.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></Field>
              <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
              <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
              <Field label="Job No"><input value={f.job} placeholder="GAR-2026-00001" onChange={(e) => setF({ ...f, job: e.target.value })} /></Field>
              <Field label="Buyer"><input value={f.buyer} onChange={(e) => setF({ ...f, buyer: e.target.value })} /></Field>
              <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{statuses.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Department"><select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}><option value="">All</option>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></Field>
              <Field label="Created by (user)"><UserPick value={f.createdBy} onChange={(v) => setF({ ...f, createdBy: v })} /></Field>
            </div>
            <div className="row-wrap mt">
              <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : <Icon name="Play" size={15} />} Run report</button>
              <div className="grow" />
              {data && <button className="btn" onClick={() => reportPdf(rep.title, data.columns, data.rows, filterText)}><Icon name="FileDown" size={15} /> PDF</button>}
              {(can('reports', 'export') || can(rep?.module, 'export')) && <>
                <button className="btn" onClick={() => download(`/reports/${key}`, { ...params, format: 'xlsx' }).catch((e) => toast(errMsg(e), 'err'))}><Icon name="FileSpreadsheet" size={15} /> Excel</button>
                <button className="btn" onClick={() => download(`/reports/${key}`, { ...params, format: 'csv' }).catch((e) => toast(errMsg(e), 'err'))}>CSV</button>
              </>}
              {data && <button className="btn" onClick={() => window.print()}><Icon name="Printer" size={15} /> Print</button>}
            </div>
          </Card>
          <Card title={data ? `${fmtNum(data.rows.length)} rows` : 'Results'} icon="Table" pad={false}>
            {!data ? <Empty icon="FileBarChart" title={busy ? 'Running…' : 'Run a report to see results'} /> : (
              <div className="table-wrap" style={{ maxHeight: '65vh' }}>
                <table className="tbl tbl-mini">
                  <thead><tr>{data.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {data.rows.slice(0, 500).map((r, i) => <tr key={r._id || i}>{data.columns.map((c) => <td key={c.key} className={typeof r[c.key] === 'number' ? 'num' : ''}>{show(c.key.split('.').reduce((o, k) => o?.[k], r))}</td>)}</tr>)}
                  </tbody>
                </table>
                {data.rows.length > 500 && <div className="pager">Showing first 500 rows – export for the full dataset.</div>}
                {!data.rows.length && <Empty title="No rows for these filters" />}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function UserPick({ value, onChange }) {
  const [users, setUsers] = useState([]);
  useEffect(() => { api.get('/lookup/users').then((r) => setUsers(r.data)).catch(() => {}); }, []);
  return <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">All users</option>{users.map((u) => <option key={u._id} value={u._id}>{u.label}</option>)}</select>;
}

