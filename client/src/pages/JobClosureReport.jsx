/**
 * JOB CLOSURE REPORT – the consolidated history of a main job and its sub jobs under the same Job No:
 * per-job reconciliation (fabric, production / finished goods, accounts, profit) and the complete,
 * dated transaction register from buyer PO to closure. Opens from Job 360 (any main or sub job number).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errMsg, download } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Card, Icon, Badge, StatusBadge, Loading, Empty } from '../components/ui.jsx';
import { fmtDate, fmtNum, fmtDateTime } from '../utils/format.js';

const n = (v, d = 0) => (v === null || v === undefined || v === '' ? '—' : fmtNum(v, d));

function JobSummary({ j, money }) {
  const f = j.fabric; const p = j.production; const a = j.accounts;
  const failed = j.checks.filter((c) => !c.ok && !c.info).length;
  return (
    <tr>
      <td><span className="mono">{j.jobNo}</span><div className="muted small">{j.isMain ? 'Main job (consolidated)' : j.jobType}</div></td>
      <td>{j.poNo || '—'}</td><td><StatusBadge status={j.status} /></td><td className="num">{n(j.orderQty)}</td>
      <td className="num">{n(f.received, 1)}</td><td className="num">{n(f.returnedToSupplier, 1)}</td><td className="num">{n(f.issued, 1)}</td><td className="num">{n(f.returnedFromCutting, 1)}</td><td className="num">{n(f.usedInCutting, 1)}</td><td className="num">{n(f.storeBalance, 1)}</td>
      <td className="num">{n(p.cut)}</td><td className="num">{n(p.sewn)}</td><td className="num">{n(p.finished)}</td><td className="num">{n(p.rejected)}</td><td className="num">{n(p.qcPassed)}</td><td className="num">{n(p.packed)}</td><td className="num">{n(p.shipped)}</td><td className="num">{n(p.finishedGoodsBalance)}</td>
      {money && a && <><td className="num">{n(a.invoiced, 2)}</td><td className="num">{n(a.received, 2)}</td><td className="num">{n(a.cost, 2)}</td><td className="num">{n(a.revenue, 2)}</td><td className="num" style={{ fontWeight: 650, color: a.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{n(a.profit, 2)}</td></>}
      <td className="num">{j.debits.count ? `${j.debits.count}${j.debits.open ? ` (${j.debits.open} open)` : ''}` : '—'}</td>
      <td>{failed ? <Badge tone="red">{failed} mismatch</Badge> : <Badge tone="green">Reconciled</Badge>}</td>
    </tr>
  );
}

export default function JobClosureReport() {
  const { jobNo } = useParams();
  const { can } = useAuth();
  const { toast } = useFeedback();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('ALL');
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => { api.get(`/jobs/${encodeURIComponent(jobNo)}/closure-report`).then((r) => { setD(r.data); if (r.data.main.jobNo !== jobNo) setSel(jobNo); }).catch((e) => setErr(errMsg(e))); }, [jobNo]);
  const rows = useMemo(() => {
    if (!d) return [];
    const s = q.trim().toLowerCase();
    return d.rows.filter((r) => (sel === 'ALL' || r.jobNo === sel) && (!dept || r.department === dept)
      && (!s || [r.refNo, r.txType, r.description, r.status].some((x) => String(x || '').toLowerCase().includes(s))));
  }, [d, sel, dept, q]);
  if (err) return <Empty icon="SearchX" title={err}><Link to="/control-tower">Search another job</Link></Empty>;
  if (!d) return <Loading />;
  const money = can('profit', 'view');
  const m = d.main;
  const focus = d.jobs.find((j) => j.jobNo === sel) || d.jobs[0];
  const depts = [...new Set(d.rows.map((r) => r.department))];
  const tot = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  const exportAs = (format) => download(`/jobs/${m.jobNo}/closure-report`, { format }).catch((e) => toast(errMsg(e), 'err'));

  return (
    <div className="closure-report">
      <PageHead icon="ListChecks" crumbs={<><Link to="/control-tower">Control Tower</Link> / <Link to={`/jobs/${m.jobNo}`}>{m.jobNo}</Link></>}
        title={<>Job Closure Report · <span className="mono">{m.jobNo}</span></>}
        subtitle={<>{d.unitName} · {m.buyerName} · Style <b>{m.styleNo}</b> · PO <b>{m.poNo || '—'}</b> · Order {m.orderNo}{d.subJobs.length ? ` · ${d.subJobs.length} sub jobs: ${d.subJobs.join(', ')}` : ''}</>}>
        <StatusBadge status={m.status} />
        {d.isSampleData && <Badge tone="amber" dot={false}>Sample / Test data</Badge>}
        {d.checksPassed ? <Badge tone="green">All quantities & amounts reconciled</Badge> : <Badge tone="red">Reconciliation differences</Badge>}
        {can('reports', 'export') && <><button className="btn" onClick={() => exportAs('xlsx')}><Icon name="FileSpreadsheet" size={15} /> Excel</button><button className="btn" onClick={() => exportAs('csv')}>CSV</button></>}
        <button className="btn no-print" onClick={() => window.print()}><Icon name="Printer" size={15} /> Print</button>
        <button className="btn no-print" onClick={() => nav(`/jobs/${m.jobNo}`)}><Icon name="RadioTower" size={15} /> Job 360</button>
      </PageHead>

      <Card title="Main job and sub jobs – reconciled totals" icon="GitFork" pad={false}>
        <table className="tbl tbl-mini">
          <thead>
            <tr><th colSpan={4} /><th colSpan={6} style={{ textAlign: 'center' }}>Fabric ({focus.fabric.unit || '—'})</th><th colSpan={8} style={{ textAlign: 'center' }}>Production & finished goods (pcs)</th>{money && <th colSpan={5} style={{ textAlign: 'center' }}>Accounts ({m.currency || 'USD'})</th>}<th colSpan={2} /></tr>
            <tr><th>Job</th><th>PO</th><th>Status</th><th className="num">Order</th>
              <th className="num">Received</th><th className="num">Ret. supplier</th><th className="num">Issued</th><th className="num">Ret. cutting</th><th className="num">Used</th><th className="num">Store bal.</th>
              <th className="num">Cut</th><th className="num">Sewn</th><th className="num">Finished</th><th className="num">Rejected</th><th className="num">QC passed</th><th className="num">Packed (FG in)</th><th className="num">Shipped (FG out)</th><th className="num">FG bal.</th>
              {money && <><th className="num">Invoiced</th><th className="num">Received</th><th className="num">Cost</th><th className="num">Revenue</th><th className="num">Profit</th></>}
              <th className="num">Debit notes</th><th>Check</th></tr>
          </thead>
          <tbody>{d.jobs.map((j) => <JobSummary key={j.jobNo} j={j} money={money} />)}</tbody>
        </table>
      </Card>

      <Card className="mt" title={`Open items – ${focus.isMain ? `${focus.jobNo} and its sub jobs` : focus.jobNo} (${focus.openItems.length})`} icon="AlertTriangle" pad={false}>
        {!focus.openItems.length ? <div className="muted small" style={{ padding: 12 }}>Nothing open – no unresolved debits, pending receipts, unshipped goods or outstanding payments.</div> : (
          <table className="tbl tbl-mini">
            <thead><tr><th>Open item</th><th>Reference</th><th>Details</th>{money && <th className="num">Amount</th>}</tr></thead>
            <tbody>{focus.openItems.map((o, i) => <tr key={i}><td><Badge tone={/payment|outstanding|debit/i.test(o.type) ? 'amber' : 'blue'}>{o.type}</Badge></td><td className="mono small">{o.ref}</td><td className="small">{o.detail}</td>{money && <td className="num">{n(o.amount, 2)}</td>}</tr>)}</tbody>
          </table>
        )}
      </Card>

      <div className="row-wrap mt no-print">
        <div className="seg">
          <button type="button" className={sel === 'ALL' ? 'on' : ''} onClick={() => setSel('ALL')}>All ({d.rows.length})</button>
          {d.jobs.map((j) => <button key={j.jobNo} type="button" className={sel === j.jobNo ? 'on' : ''} onClick={() => setSel(j.jobNo)}>{j.jobNo}{j.isMain ? ' (main)' : ''} · {j.transactions}</button>)}
        </div>
        <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ width: 'auto', height: 32 }} aria-label="Department"><option value="">All departments</option>{depts.map((x) => <option key={x}>{x}</option>)}</select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ref / transaction / details" style={{ width: 260, height: 32 }} />
      </div>

      {sel !== 'ALL' && (
        <Card className="mt" title={`Reconciliation – ${focus.jobNo}`} icon="ListChecks">
          <div className="grid g2">
            {focus.checks.map((c) => (
              <div key={c.label} className="row small" style={{ gap: 8 }}>
                <Icon name={c.info ? 'Info' : c.ok ? 'CheckCircle2' : 'XCircle'} size={15} style={{ color: c.info ? 'var(--blue)' : c.ok ? 'var(--green)' : 'var(--red)' }} />
                <span className="grow">{c.label}</span><span className="mono muted">{typeof c.expected === 'number' ? fmtNum(c.expected, 2) : c.expected} · {typeof c.actual === 'number' ? fmtNum(c.actual, 2) : c.actual}</span>
              </div>
            ))}
          </div>
          {money && focus.accounts && <div className="muted small mt">Cost basis by bucket: {Object.entries(focus.accounts.costBasis || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}. Standard cost is applied only to a bucket with no actual cost booked, and is listed as a transaction.</div>}
        </Card>
      )}

      <Card className="mt" title={`Transaction register (${rows.length})`} icon="History" pad={false}
        actions={<span className="muted small">Generated {fmtDateTime(d.generatedAt)}</span>}>
        {!rows.length ? <Empty title="No transactions match" /> : (
          <table className="tbl tbl-mini">
            <thead><tr><th>#</th><th>Date</th><th>Job</th><th>Department</th><th>Transaction</th><th>Ref No</th><th>Details</th><th className="num">Qty</th><th>Unit</th>{money && <><th className="num">Rate</th><th className="num">Amount</th><th className="num">Job Cost</th><th className="num">Revenue</th></>}<th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.seq} className={r.module && r.recordId && !['orders', 'profit', 'documents'].includes(r.module) ? 'click' : ''} onClick={() => r.module && r.recordId && !['orders', 'profit', 'documents'].includes(r.module) && nav(`/m/${r.module}/${r.recordId}`)}>
                <td className="muted">{r.seq}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td><td className="mono">{r.jobNo}</td><td className="small">{r.department}</td>
                <td><b className="small">{r.txType}</b></td><td className="mono small">{r.refNo || '—'}</td><td className="small" style={{ minWidth: 260 }}>{r.description}</td>
                <td className="num">{n(r.qty, Number.isInteger(r.qty) ? 0 : 2)}</td><td className="small">{r.unit}</td>
                {money && <><td className="num">{n(r.rate, 3)}</td><td className="num">{n(r.amount, 2)}</td>
                  <td className="num" style={{ color: r.costImpact < 0 ? 'var(--green)' : undefined }}>{r.costImpact ? fmtNum(r.costImpact, 2) : ''}</td><td className="num">{r.revenueImpact ? fmtNum(r.revenueImpact, 2) : ''}</td></>}
                <td><StatusBadge status={r.status} /></td>
              </tr>
            ))}</tbody>
            {money && <tfoot><tr><td colSpan={11}>Totals (filtered)</td><td className="num">{fmtNum(tot('costImpact'), 2)}</td><td className="num">{fmtNum(tot('revenueImpact'), 2)}</td><td>{tot('revenueImpact') ? `Profit ${fmtNum(tot('revenueImpact') - tot('costImpact'), 2)}` : ''}</td></tr></tfoot>}
          </table>
        )}
      </Card>
    </div>
  );
}
