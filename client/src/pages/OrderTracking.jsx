/**
 * ORDER & JOB TRACKING – new orders, repeat / forecast orders, advance jobs, pending PO, unfinished jobs,
 * finished-but-not-shipped, shipment and closure lists for the selected unit (or both units).
 * Every count and quantity comes from the live transactions (see server/src/services/tracking.js).
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TRACKING_LISTS, TRACKING_LIST, MAIN_JOB_COLUMNS } from '@shared/tracking.js';
import { MODULES } from '@shared/modules/index.js';
import { api, errMsg, download } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Card, Icon, Badge, StatusBadge, Loading, Empty, Progress } from '../components/ui.jsx';
import { UnitScope, useUnitName } from '../components/UnitScope.jsx';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { fmtDate, fmtNum } from '../utils/format.js';

const GROUPS = [
  { title: 'Orders', keys: ['newOrders', 'awaitingJob'] },
  { title: 'Repeat & forecast', keys: ['repeatOrders', 'forecastOrders', 'advanceAwaitingPo'] },
  { title: 'Pending & production', keys: ['pendingPo', 'awaitingFabric', 'underProduction', 'unfinished'] },
  { title: 'Shipment', keys: ['finishedPendingShipment', 'partiallyShipped', 'fullyShipped'] },
  { title: 'Closure', keys: ['subJobsReadyForClosure', 'closedSubJobs', 'mainJobsPendingClosure'] },
  { title: 'Purchasing, holds & deadlines', keys: ['poPendingReceipt', 'notStarted', 'onHold', 'overdue', 'awaitingClosure'] },
];
const ATTENTION = ['awaitingJob', 'advanceAwaitingPo', 'pendingPo', 'awaitingFabric', 'finishedPendingShipment', 'subJobsReadyForClosure', 'mainJobsPendingClosure', 'poPendingReceipt', 'onHold', 'overdue'];
const MAIN_VIEW = { key: 'mainJobs', title: 'Main Job Dashboard', icon: 'GitFork', kind: 'main', columns: MAIN_JOB_COLUMNS, desc: 'Every main job with its sub jobs: quantities, production progress, pending shipment, cost, revenue, profit and closure status.' };
const EMPTY_FILTERS = { buyer: '', jobNo: '', poNo: '', from: '', to: '', stage: '' };

const remember = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* storage unavailable */ } return null; };

function badgeTone(v) {
  const s = String(v || '');
  if (/^Delayed|Awaiting PO|Not booked|Unpaid|Not invoiced|awaiting PO|Awaiting confirmed/i.test(s)) return 'red';
  if (/^Due in|Partially|Part paid|Partly|of \d+ |Balance|Forecast/i.test(s)) return 'amber';
  if (/^On time|Completed|Fully|All |Received|Confirmed|Closed|Issued|PO Received|confirmed/i.test(s)) return 'green';
  return 'blue';
}

function Cell({ col, row, onJob }) {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  switch (col.type) {
    case 'num': return fmtNum(v, Number.isInteger(v) ? 0 : 1);
    case 'money': return fmtNum(v, 0);
    case 'date': return fmtDate(v);
    case 'status': return <StatusBadge status={v} />;
    case 'badge': return <Badge tone={badgeTone(v)}>{v}</Badge>;
    case 'job': return (
      <span className="mono link" role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); onJob(v); }} onKeyDown={(e) => e.key === 'Enter' && onJob(v)}>{v}</span>
    );
    default: return String(v);
  }
}

function ListTable({ list, rows, withProfit, onRow, onJob }) {
  const columns = list.columns.filter((c) => withProfit || c.type !== 'money');
  return (
    <table className="tbl">
      <thead><tr>{columns.map((c) => <th key={c.key} className={['num', 'money'].includes(c.type) ? 'num' : ''}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={`${r.kind || 'job'}-${r._id}`} className="click" onClick={() => onRow(r)}>
          {columns.map((c) => (
            <td key={c.key} className={['num', 'money'].includes(c.type) ? 'num' : c.key === 'pendingReason' || c.key === 'blockers' || c.key === 'subJobs' ? 'small' : ''} style={c.key === 'blockers' || c.key === 'subJobs' ? { minWidth: 220 } : undefined}>
              <Cell col={c} row={r} onJob={onJob} />
              {c.type === 'job' && r.isSampleData && r[c.key] && (c.key === 'jobNo' || c.key === 'mainJobNo') && <span className="trk-sample" title="Sample / test data">SAMPLE</span>}
            </td>
          ))}
        </tr>
      ))}</tbody>
    </table>
  );
}

function MainJobs({ rows, withProfit, onJob }) {
  const [open, setOpen] = useState({});
  if (!rows.length) return <Empty title="No main jobs with sub jobs" />;
  return (
    <table className="tbl">
      <thead><tr><th /><th>Main Job</th><th>Buyer / Style</th><th>Actual PO</th><th className="num">Sub Jobs</th><th className="num">Ordered</th><th className="num">Packed</th><th className="num">Shipped</th><th className="num">Pending Ship</th><th>Progress</th>{withProfit && <><th className="num">Cost</th><th className="num">Revenue</th><th className="num">Profit</th></>}<th>Closure</th></tr></thead>
      <tbody>{rows.map((m) => (
        <Fragment key={m._id}>
          <tr className="click" onClick={() => setOpen((o) => ({ ...o, [m._id]: !o[m._id] }))}>
            <td><Icon name={open[m._id] ? 'ChevronDown' : 'ChevronRight'} size={15} /></td>
            <td><span className="mono link" onClick={(e) => { e.stopPropagation(); onJob(m.jobNo); }}>{m.jobNo}</span>{m.isSampleData && <span className="trk-sample">SAMPLE</span>}<div className="muted small">{m.unitName} · {m.forecastStatus}</div></td>
            <td>{m.buyerName}<div className="muted small">{m.styleNo}</div></td>
            <td className="small">{m.poStatusText}</td>
            <td className="num">{m.subClosed} / {m.subCount} closed</td>
            <td className="num">{fmtNum(m.orderQty)}</td><td className="num">{fmtNum(m.packedQty)}</td><td className="num">{fmtNum(m.shippedQty)}</td><td className="num">{fmtNum(m.balanceToShip)}</td>
            <td style={{ minWidth: 110 }}><Progress value={m.progressPct} /><div className="muted small">{m.progressPct}%</div></td>
            {withProfit && <><td className="num">{fmtNum(m.cost)}</td><td className="num">{fmtNum(m.revenue)}</td><td className="num" style={{ color: m.profit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 650 }}>{fmtNum(m.profit)}</td></>}
            <td><StatusBadge status={m.status} />{m.blockers && <div className="muted small" style={{ maxWidth: 260 }}>{m.blockers}</div>}</td>
          </tr>
          {open[m._id] && (
            <tr><td /><td colSpan={withProfit ? 13 : 10} style={{ background: 'var(--surface-2)' }}>
              <table className="tbl tbl-mini">
                <thead><tr><th>Sub Job</th><th>PO</th><th className="num">Qty</th><th className="num">Cut</th><th className="num">Sewn</th><th className="num">Packed</th><th className="num">Shipped</th><th className="num">Balance</th><th>Stage</th><th>Delivery</th>{withProfit && <><th className="num">Cost</th><th className="num">Revenue</th><th className="num">Profit</th></>}<th>Status</th></tr></thead>
                <tbody>{m.subs.map((s) => (
                  <tr key={s._id} className="click" onClick={() => onJob(s.jobNo)}>
                    <td className="mono link">{s.jobNo}</td><td>{s.poStatus === 'Awaiting PO' ? <Badge tone="red">Awaiting PO</Badge> : s.poNo}</td>
                    <td className="num">{fmtNum(s.orderQty)}</td><td className="num">{fmtNum(s.cutQty)}</td><td className="num">{fmtNum(s.sewnQty)}</td><td className="num">{fmtNum(s.packedQty)}</td><td className="num">{fmtNum(s.shippedQty)}</td><td className="num">{fmtNum(s.balanceToShip)}</td>
                    <td className="small">{s.pendingStageLabel}</td><td>{fmtDate(s.deliveryDate)}</td>
                    {withProfit && <><td className="num">{fmtNum(s.cost)}</td><td className="num">{fmtNum(s.revenue)}</td><td className="num">{fmtNum(s.profit)}</td></>}
                    <td><StatusBadge status={s.status} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </td></tr>
          )}
        </Fragment>
      ))}</tbody>
    </table>
  );
}

export default function OrderTracking() {
  const { user, can } = useAuth();
  const { toast } = useFeedback();
  const nav = useNavigate();
  const unitName = useUnitName();
  const [scope, setScope] = useState('');
  const [f, setF] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState(null); // { status, message } of the last failed load
  const [sel, setSel] = useState(() => remember('trk.list') || 'unfinished');
  const [drawer, setDrawer] = useState(null);
  const withProfit = can('profit', 'view');

  const params = useMemo(() => ({ unit: scope || undefined, ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v)) }), [scope, applied]);
  const load = () => {
    setBusy(true);
    api.get('/tracking', { params })
      .then((r) => { setD(r.data); setLoadErr(null); })
      .catch((e) => {
        const status = e?.response?.status;
        // a 404 here means the API answering this page does not have the tracking endpoint (older backend build)
        const message = status === 404 ? 'The API server answering this page has no Order & Job Tracking endpoint (/api/tracking) – it runs an older version of the backend. Start the local API (npm run dev) or redeploy the backend.' : errMsg(e);
        setLoadErr({ status, message });
        toast(message, 'err');
        setD((x) => x || false); // keep lists already on screen; show the error state only when nothing was loaded
      })
      .finally(() => setBusy(false));
  };
  useEffect(load, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (k) => { setSel(k); remember('trk.list', k); };

  if (d === null) return <Loading />;
  if (d === false) {
    return (
      <Empty icon="AlertTriangle" title={`Order & Job Tracking could not be loaded${loadErr?.status ? ` (HTTP ${loadErr.status})` : ''}`}>
        <div style={{ maxWidth: 560 }}>{loadErr?.message}</div>
        <button className="btn mt" onClick={load} disabled={busy}><Icon name="RefreshCw" size={15} /> Try again</button>
      </Empty>
    );
  }
  const list = sel === 'mainJobs' ? MAIN_VIEW : TRACKING_LIST[sel] || TRACKING_LIST.unfinished;
  const rows = sel === 'mainJobs' ? d.mainJobs : d.lists[list.key] || [];
  const openJob = (jobNo) => jobNo && nav(`/jobs/${jobNo}`);
  const openRow = (r) => (r.source === 'order' ? setDrawer(r._id) : r.kind === 'po' ? nav(`/m/${r.module}/${r._id}`) : openJob(r.subJobNo || r.jobNo));
  const anySample = Object.values(d.lists).some((l) => l.some((r) => r.isSampleData));
  const scopeText = scope === 'ALL' ? 'Both units – consolidated' : unitName(scope) || user.unit.name;
  const fullyPacked = sel === 'finishedPendingShipment' ? rows.filter((r) => r.fullyPacked) : [];
  const partPacked = sel === 'finishedPendingShipment' ? rows.filter((r) => !r.fullyPacked) : [];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div>
      <PageHead title={`Order & Job Tracking · ${scopeText}`} icon="ListChecks" subtitle="New orders, repeat & forecast orders, advance jobs, pending PO, unfinished jobs, finished goods awaiting shipment and closure – live from ERP transactions.">
        <UnitScope value={scope} onChange={setScope} style={{ height: 36, width: 'auto' }} />
        {can('buyerOrder', 'create') && <button className="btn" onClick={() => setDrawer('new')}><Icon name="Plus" size={15} /> New buyer order</button>}
        {can('reports', 'export') && <button className="btn" onClick={() => download('/tracking/export', { ...params, list: list.key, format: 'xlsx' }).catch((e) => toast(errMsg(e), 'err'))}><Icon name="FileSpreadsheet" size={15} /> Excel</button>}
        <button className="btn" onClick={load} disabled={busy}><Icon name="RefreshCw" size={15} /> Refresh</button>
      </PageHead>

      {loadErr && <div className="alert alert-red mb"><Icon name="AlertTriangle" /> Refresh failed{loadErr.status ? ` (HTTP ${loadErr.status})` : ''}: {loadErr.message} The lists below are from the last successful load.</div>}
      {anySample && <div className="alert alert-info mb"><Icon name="Info" /> These lists include <b>Sample / Test data</b> (marked SAMPLE) created for testing the Unit-1 / Unit-2 workflow.</div>}

      <div className="card card-pad mb">
        <div className="trk-filters">
          <select value={f.buyer} onChange={set('buyer')} aria-label="Buyer"><option value="">All buyers</option>{d.buyers.map((b) => <option key={b}>{b}</option>)}</select>
          <input value={f.jobNo} onChange={set('jobNo')} placeholder={`Job / sub job (${user.unit.prefix}-…)`} aria-label="Job No" />
          <input value={f.poNo} onChange={set('poNo')} placeholder="PO No" aria-label="PO No" />
          <label className="small muted">Delivery from <input type="date" value={f.from} onChange={set('from')} /></label>
          <label className="small muted">to <input type="date" value={f.to} onChange={set('to')} /></label>
          <select value={f.stage} onChange={set('stage')} aria-label="Pending stage"><option value="">Any pending stage</option>{d.stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
          <button className="btn btn-primary" onClick={() => setApplied(f)}><Icon name="Search" size={15} /> Apply</button>
          {Object.values(applied).some(Boolean) && <button className="btn" onClick={() => { setF(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }}><Icon name="X" size={15} /> Clear</button>}
        </div>
        <div className="row-wrap small muted" style={{ marginTop: 10 }}>
          <span className="chip">Confirmed order qty {fmtNum(d.totals.confirmedQty)}</span>
          <span className="chip">Forecast qty (not confirmed) {fmtNum(d.totals.forecastQty)}</span>
          <span className="chip">Shipped {fmtNum(d.totals.shippedQty)}</span>
          <span className="chip">Finished, pending shipment {fmtNum(d.totals.pendingShipmentQty)}</span>
        </div>
      </div>

      <div className="trk-groups">
        {GROUPS.map((g) => (
          <div key={g.title} className="trk-group">
            <div className="trk-group-title">{g.title}</div>
            <div className="trk-tiles">
              {g.keys.map((k) => {
                const l = TRACKING_LIST[k]; const n = d.counts[k];
                return (
                  <button key={k} type="button" className={`trk-tile ${sel === k ? 'on' : ''} ${n && ATTENTION.includes(k) ? 'warn' : ''}`} onClick={() => pick(k)} title={l.desc}>
                    <Icon name={l.icon} size={16} /><span className="trk-n">{n}</span><span className="trk-t">{l.title}</span>
                  </button>
                );
              })}
              {g.title === 'Closure' && (
                <button type="button" className={`trk-tile ${sel === 'mainJobs' ? 'on' : ''}`} onClick={() => pick('mainJobs')} title={MAIN_VIEW.desc}>
                  <Icon name="LayoutGrid" size={16} /><span className="trk-n">{d.mainJobs.length}</span><span className="trk-t">Main Job Dashboard</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Card className="mt" title={`${list.title} (${rows.length})`} icon={list.icon} pad={false}
        actions={<span className="muted small" style={{ maxWidth: 520 }}>{list.desc}</span>}>

        {!rows.length ? <Empty title={`No ${list.title.toLowerCase()}`}>{Object.values(applied).some(Boolean) ? 'Try clearing the filters.' : 'Nothing is waiting here.'}</Empty>
          : sel === 'mainJobs' ? <MainJobs rows={rows} withProfit={withProfit} onJob={openJob} />
            : sel === 'finishedPendingShipment' ? (
              <>
                <div className="trk-subhead"><Icon name="PackageCheck" size={15} /> Fully packed – awaiting shipment ({fullyPacked.length})</div>
                {fullyPacked.length ? <ListTable list={list} rows={fullyPacked} withProfit={withProfit} onRow={openRow} onJob={openJob} /> : <div className="muted small" style={{ padding: 12 }}>None</div>}
                <div className="trk-subhead"><Icon name="Boxes" size={15} /> Partially packed ({partPacked.length})</div>
                {partPacked.length ? <ListTable list={list} rows={partPacked} withProfit={withProfit} onRow={openRow} onJob={openJob} /> : <div className="muted small" style={{ padding: 12 }}>None</div>}
              </>
            ) : <ListTable list={list} rows={rows} withProfit={withProfit} onRow={openRow} onJob={openJob} />}
      </Card>
      <div className="muted small mt">Updated {new Date(d.generatedAt).toLocaleTimeString('en-GB')} · lists follow posted transactions (bookings, receipts, production, packing, inspections, shipments, invoices, payments).</div>

      {drawer && <RecordDrawer def={MODULES.buyerOrder} id={drawer === 'new' ? null : drawer} onClose={() => setDrawer(null)} onSaved={load} />}
    </div>
  );
}
