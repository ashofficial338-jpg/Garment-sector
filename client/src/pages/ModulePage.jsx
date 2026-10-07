/** Generic module list page: search, sort, filter, pagination, export, create/edit drawer. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { MODULES } from '@shared/modules/index.js';
import { api, errMsg, download } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { DataTable } from '../components/DataTable.jsx';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { PageHead, Icon, StatusBadge, Progress, Badge, Empty } from '../components/ui.jsx';
import { fmtDate, fmtSmart, fmtNum, STAGE_LABEL } from '../utils/format.js';
import { reportPdf } from '../utils/pdf.js';

export function cellValue(f, r) {
  const v = r[f.name];
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (f.type === 'date') return fmtDate(v);
  if (f.type === 'number') return fmtSmart(v);
  if (f.type === 'ref') return typeof v === 'object' ? (v.name || v.refNo || v.jobNo || v.invoiceNo) : '…';
  if (f.type === 'boolean') return v ? 'Yes' : 'No';
  if (f.type === 'tags') return v.join(', ');
  if (f.name === 'closureVerdict' || f.name === 'aqlResult') return <StatusBadge status={v} />;
  return String(v);
}

export default function ModulePage({ moduleKey }) {
  const params = useParams();
  const key = moduleKey || params.key;
  const def = MODULES[key];
  const { can, user } = useAuth();
  const { toast } = useFeedback();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [data, setData] = useState({ rows: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(sp.get('q') || '');
  const [qDebounced, setQD] = useState(q);
  const [filters, setFilters] = useState(() => Object.fromEntries([...sp.entries()].filter(([k]) => k.startsWith('f_')).map(([k, v]) => [k.slice(2), v])));
  const [status, setStatus] = useState(sp.get('status') || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [sort, setSort] = useState('-createdAt');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [creating, setCreating] = useState(false);
  const job = sp.get('job') || '';
  const openId = params.id;

  useEffect(() => { const t = setTimeout(() => setQD(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [qDebounced, filters, status, from, to, deleted, job, key]);

  const query = useMemo(() => ({
    q: qDebounced || undefined, status: status || undefined, job: job || undefined, from: from || undefined, to: to || undefined,
    deleted: deleted ? 'true' : undefined, sort, page, limit,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [`f_${k}`, v])),
  }), [qDebounced, status, job, from, to, deleted, sort, page, limit, filters]);

  const load = useCallback(async () => {
    if (!def) return;
    setLoading(true);
    try { setData((await api.get(`/m/${key}`, { params: query })).data); } catch (e) { toast(errMsg(e), 'err'); } finally { setLoading(false); }
  }, [key, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  if (!def) return <Empty title="Module not found" />;
  if (!can(key, 'view')) return <Empty icon="Lock" title="You do not have access to this module" />;

  const listFields = def.fields.filter((f) => f.list).slice(0, 8);
  const filterFields = def.fields.filter((f) => f.filter && f.type === 'select');
  const columns = [
    def.isJob
      ? { key: 'jobNo', label: 'Job No', render: (r) => <span className="link mono">{r.jobNo}</span> }
      : { key: 'refNo', label: 'Ref No', render: (r) => <span className="link mono">{r.refNo}</span> },
    ...(def.jobLinked ? [
      { key: 'jobNo', label: 'Job No', render: (r) => (r.jobNo ? <Link className="mono" to={`/jobs/${r.jobNo}`} onClick={(e) => e.stopPropagation()}>{r.jobNo}</Link> : '—') },
      { key: 'buyerName', label: 'Buyer', render: (r) => r.buyerName || '—' },
      { key: 'styleNo', label: 'Style' },
    ] : def.fields.some((f) => f.name === 'buyer') && !def.isJob ? [{ key: 'buyerName', label: 'Buyer', render: (r) => r.buyerName || '—' }] : def.isJob ? [{ key: 'buyerName', label: 'Buyer', render: (r) => r.buyerName || '—' }] : []),
    ...listFields.filter((f) => !(def.isJob && f.name === 'jobNo') && !(def.jobLinked && f.name === 'styleNo'))
      .map((f) => ({ key: f.name, label: f.label.replace(/ \(.*\)$/, ''), num: f.type === 'number', render: (r) => cellValue(f, r) })),
    ...(def.isJob ? [{ key: 'currentStage', label: 'Stage', render: (r) => <div style={{ minWidth: 120 }}><div className="small" style={{ fontWeight: 600 }}>{STAGE_LABEL[r.currentStage] || '—'}</div><Progress value={r.progressPct} /></div> }] : []),
    { key: 'status', label: 'Status', render: (r) => <div className="row"><StatusBadge status={r.status} />{r.readyToClose && <Badge tone="violet">Ready to close</Badge>}</div> },
  ].filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i);

  const exportAs = async (format) => {
    const p = { ...query, page: undefined, limit: undefined, format };
    try {
      if (format === 'pdf') {
        const { data: d } = await api.get(`/m/${key}/export`, { params: { ...p, format: undefined } });
        reportPdf(def.title, d.columns.filter((c) => !['createdByName', 'createdAt'].includes(c.key)).slice(0, 14), d.rows, job ? `Job ${job}` : '');
      } else await download(`/m/${key}/export`, p, `${key}.${format}`);
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const closeDrawer = () => { if (openId) nav(`/m/${key}${job ? `?job=${job}` : ''}`); setCreating(false); };

  return (
    <div>
      <PageHead
        title={def.title}
        icon={def.icon}
        crumbs={<>{def.group} <Icon name="ChevronRight" size={12} /> {def.department}</>}
        subtitle={job ? <>Filtered by job <b className="mono">{job}</b> · <a onClick={() => { sp.delete('job'); setSp(sp); }} style={{ cursor: 'pointer' }}>clear</a></> : `${fmtNum(data.total)} records`}
      >
        {can(key, 'export') && (
          <div className="seg">
            <button onClick={() => exportAs('xlsx')}><Icon name="FileSpreadsheet" size={14} /> Excel</button>
            <button onClick={() => exportAs('csv')}>CSV</button>
            <button onClick={() => exportAs('pdf')}>PDF</button>
          </div>
        )}
        {can(key, 'create') && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="Plus" size={16} /> {def.isJob ? 'Confirm New Order' : `New ${def.singular}`}
          </button>
        )}
      </PageHead>

      <div className="card">
        <div className="table-toolbar">
          <div className="search"><Icon name="Search" size={15} /><input className="search-input" placeholder={`Search ${def.title.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {[...def.statuses, ...(def.closeStatuses || [])].map((s) => <option key={s}>{s}</option>)}
          </select>
          {filterFields.map((f) => (
            <select key={f.name} value={filters[f.name] || ''} onChange={(e) => setFilters({ ...filters, [f.name]: e.target.value })}>
              <option value="">All {f.label.toLowerCase()}</option>
              {f.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          ))}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From date" className="hide-sm" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To date" className="hide-sm" />
          {user.isAdmin && <label className="check small"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Deleted</label>}
          <div className="grow" />
          <button className="btn btn-sm btn-ghost" onClick={load} title="Refresh"><Icon name="RefreshCw" size={15} /></button>
        </div>
        <DataTable
          columns={columns} rows={data.rows} loading={loading} sort={sort} onSort={setSort}
          onRowClick={(r) => nav(`/m/${key}/${r._id}${job ? `?job=${job}` : ''}`)}
          page={page} pages={data.pages} total={data.total} limit={limit} onPage={setPage} onLimit={setLimit}
          empty={<Empty icon={def.icon} title={`No ${def.title.toLowerCase()} found`}>{can(key, 'create') ? 'Use the button above to create one.' : ''}</Empty>}
        />
      </div>

      {(creating || openId) && (
        <RecordDrawer key={openId || 'new'} def={def} id={creating ? null : openId} initialJob={creating ? job : null} onClose={closeDrawer} onSaved={load} />
      )}
    </div>
  );
}
