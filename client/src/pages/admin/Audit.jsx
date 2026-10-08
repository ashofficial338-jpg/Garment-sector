import { useEffect, useState } from 'react';
import { api, errMsg, download } from '../../api.js';
import { useFeedback } from '../../components/Feedback.jsx';
import { PageHead, Icon, Card, Badge, Modal } from '../../components/ui.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { fmtDateTime } from '../../utils/format.js';
import { UnitScope, useUnitName } from '../../components/UnitScope.jsx';

const ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'STATUS', 'OVERRIDE', 'CLOSE', 'REOPEN', 'APPROVE', 'LOGIN', 'LOGIN_FAILED', 'UNIT_SELECT', 'UNIT_SWITCH', 'PASSWORD_CHANGE', 'PASSWORD_RESET', 'EXPORT', 'UPLOAD', 'VERSION', 'SUBJOB', 'REVISE', 'SETTINGS'];
const TONE = { DELETE: 'red', OVERRIDE: 'red', LOGIN_FAILED: 'red', CREATE: 'green', RESTORE: 'green', CLOSE: 'violet', UPDATE: 'blue', STATUS: 'amber' };
const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v));

export default function Audit() {
  const { toast } = useFeedback();
  const unitName = useUnitName();
  const [f, setF] = useState({ unit: '', q: '', action: '', module: '', jobNo: '', from: '', to: '' });
  const [data, setData] = useState({ rows: [], total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);
  const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => api.get('/admin/audit', { params: { ...params, page, limit: 30 } }).then((r) => setData(r.data)).catch((e) => toast(errMsg(e), 'err')).finally(() => setLoading(false)), 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(f), page]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = [
    { key: 'createdAt', label: 'Date / time', render: (r) => <span className="small nowrap">{fmtDateTime(r.createdAt)}</span> },
    ...(f.unit === 'ALL' ? [{ key: 'businessUnit', label: 'Unit', render: (r) => <span className="small nowrap">{unitName(r.businessUnit) || '—'}</span> }] : []),
    { key: 'userName', label: 'User' },
    { key: 'action', label: 'Action', render: (r) => <Badge tone={TONE[r.action] || 'grey'} dot={false}>{r.action}</Badge> },
    { key: 'module', label: 'Module' },
    { key: 'jobNo', label: 'Job No', render: (r) => <span className="mono small">{r.jobNo || '—'}</span> },
    { key: 'message', label: 'Description', render: (r) => <div style={{ maxWidth: 520 }}>{r.message}{r.reason && <div className="muted small">Reason: {r.reason}</div>}</div> },
    { key: 'ip', label: 'IP', render: (r) => <span className="muted small">{r.ip}</span> },
  ];

  return (
    <div>
      <PageHead title="Audit Trail" icon="History" subtitle="Every important action – who, when, what changed (old → new), module, job and device.">
        <button className="btn" onClick={() => download('/admin/audit', { ...params, format: 'xlsx' }).catch((e) => toast(errMsg(e), 'err'))}><Icon name="FileSpreadsheet" size={15} /> Excel</button>
      </PageHead>
      <Card pad={false}>
        <div className="table-toolbar">
          <div className="search"><Icon name="Search" size={15} /><input className="search-input" placeholder="Search message, user, ref…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          <UnitScope value={f.unit} onChange={(v) => { setPage(1); setF({ ...f, unit: v }); }} />
          <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="">All actions</option>{ACTIONS.map((a) => <option key={a}>{a}</option>)}</select>
          <input placeholder="Module" value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })} style={{ width: 130 }} />
          <input placeholder="Job No" value={f.jobNo} onChange={(e) => setF({ ...f, jobNo: e.target.value })} style={{ width: 160 }} />
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <DataTable columns={columns} rows={data.rows} loading={loading} onRowClick={setSel} page={page} pages={data.pages} total={data.total} limit={30} onPage={setPage} />
      </Card>
      {sel && (
        <Modal title={`${sel.action} · ${sel.module || ''}`} onClose={() => setSel(null)} width="min(720px, calc(100vw - 32px))" footer={<button className="btn" onClick={() => setSel(null)}>Close</button>}>
          <p>{sel.message}</p>
          <div className="muted small mb">{sel.userName} · {fmtDateTime(sel.createdAt)} · {sel.ip} · {sel.userAgent?.slice(0, 80)}</div>
          {sel.changes?.length > 0 && (
            <table className="tbl tbl-mini"><thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead>
              <tbody>{sel.changes.map((c) => <tr key={c.field}><td><b>{c.field}</b></td><td style={{ color: 'var(--red)' }}>{show(c.old)}</td><td style={{ color: 'var(--green)' }}>{show(c.new)}</td></tr>)}</tbody></table>
          )}
        </Modal>
      )}
    </div>
  );
}
