/**
 * Management Analytics – the drill-down behind the dashboard KPIs:
 *   KPI → analysis (this page) → source transactions (invoices, expenses, stock movements, Job 360).
 * All figures come from /api/analytics (calculated on the server from database records), for the selected
 * unit (or both units consolidated) and reporting period. Admin by default; others need the analytics permission.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errMsg } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Card, Kpi, Tabs, Loading, Empty, Badge, Icon, StatusBadge } from '../components/ui.jsx';
import { UnitScope, useUnitName } from '../components/UnitScope.jsx';
import { fmtNum, fmtDate, fmtCurrency } from '../utils/format.js';

const TABS = [
  { key: 'finance', label: 'Revenue → EBITDA' },
  { key: 'inventory', label: 'Inventory · ITR · Holding' },
  { key: 'roi', label: 'Product / Style ROI' },
  { key: 'variance', label: 'Job Profit & Cost Variance' },
  { key: 'operations', label: 'Fabric · Production · Shipment' },
];
const iso = (d) => d.toISOString().slice(0, 10);
function preset(key) {
  const now = new Date();
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const start = { month: new Date(Date.UTC(y, m, 1)), quarter: new Date(Date.UTC(y, m - 2, 1)), ytd: new Date(Date.UTC(y, 0, 1)), '12m': new Date(Date.UTC(y, m - 11, 1)) }[key];
  return { from: iso(start), to: iso(now) };
}
const num = (v, d = 0) => (v === null || v === undefined ? '—' : fmtNum(v, d));
const ratioX = (v) => (v === null || v === undefined ? 'n/a' : `${fmtNum(v, 2)}x`);
const daysTxt = (v) => (v === null || v === undefined ? 'n/a' : `${fmtNum(v)} days`);
const pctTxt = (v) => (v === null || v === undefined ? 'n/a' : `${fmtNum(v, 2)}%`);
const tone = (v) => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : undefined);
const varTone = (v) => (v > 0 ? 'var(--red)' : v < 0 ? 'var(--green)' : undefined); // cost overrun is bad

export default function Analytics() {
  const { user } = useAuth();
  const { toast } = useFeedback();
  const unitName = useUnitName();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'finance';
  const def = preset('12m');
  const q = { from: sp.get('from') || def.from, to: sp.get('to') || def.to, unit: sp.get('unit') || '', by: sp.get('by') || 'style' };
  const set = (patch) => setSp(Object.fromEntries(Object.entries({ tab, ...q, ...patch }).filter(([, v]) => v)), { replace: true });
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    const params = { from: q.from, to: q.to, unit: q.unit || undefined, ...(tab === 'roi' ? { by: q.by } : {}) };
    api.get(`/analytics/${tab}`, { params }).then((r) => setData(r.data)).catch((e) => { toast(errMsg(e), 'err'); setData({ error: true }); });
  }, [tab, q.from, q.to, q.unit, q.by]); // eslint-disable-line react-hooks/exhaustive-deps

  const scopeLabel = q.unit === 'ALL' ? 'Both units (consolidated)' : unitName(q.unit || user.unit.code);
  const cur = data?.currency || 'USD';
  const money = (v, compact) => fmtCurrency(v, cur, compact);

  return (
    <div>
      <PageHead title="Management Analytics" icon="ChartNoAxesCombined" subtitle={`${scopeLabel} · ${q.from} → ${q.to} · every figure drills down to its Job No and source transactions`}>
        <UnitScope value={q.unit} onChange={(v) => set({ unit: v })} style={{ width: 'auto' }} />
      </PageHead>
      <div className="card card-pad mb">
        <div className="row-wrap">
          {[['month', 'This month'], ['quarter', 'Last 3 months'], ['ytd', 'Year to date'], ['12m', 'Last 12 months']].map(([k, l]) => (
            <button key={k} className={`btn btn-sm ${preset(k).from === q.from && preset(k).to === q.to ? 'btn-primary' : ''}`} onClick={() => set(preset(k))}>{l}</button>
          ))}
          <div className="grow" />
          <label className="small muted">From</label><input type="date" value={q.from} onChange={(e) => e.target.value && set({ from: e.target.value })} style={{ width: 'auto' }} />
          <label className="small muted">To</label><input type="date" value={q.to} onChange={(e) => e.target.value && set({ to: e.target.value })} style={{ width: 'auto' }} />
        </div>
      </div>
      <Tabs value={tab} onChange={(t) => setSp(Object.fromEntries(Object.entries({ ...q, tab: t }).filter(([, v]) => v)))} tabs={TABS} />
      {!data ? <Loading /> : data.error ? <Empty icon="AlertTriangle" title="Could not load analytics" /> : (
        <>
          {data.currencies?.length > 1 && <div className="alert alert-warn mb"><Icon name="AlertTriangle" size={16} /> Transactions in {data.currencies.join(', ')} are summed as recorded and shown in the base currency {cur}.</div>}
          {tab === 'finance' && <Finance d={data} money={money} />}
          {tab === 'inventory' && <Inventory d={data} money={money} />}
          {tab === 'roi' && <Roi d={data} money={money} by={q.by} onBy={(by) => set({ by })} />}
          {tab === 'variance' && <Variance d={data} money={money} />}
          {tab === 'operations' && <Operations d={data} money={money} />}
        </>
      )}
    </div>
  );
}

const JobLink = ({ r }) => (r.jobNo ? <Link className="mono link" to={`/jobs/${r.jobNo}`}>{r.jobNo}</Link> : <span className="muted">Company</span>);

/* ------------------------------ Revenue → COGS → EBITDA → Net profit ------------------------------ */
function Finance({ d, money }) {
  const [src, setSrc] = useState('sales');
  const lines = [
    ['Garment sales revenue', d.revenue, 'sales', 'b'], ['− Cost of goods sold (COGS)', -d.cogs, 'sales'], ['= Gross profit', d.grossProfit, null, 'b'],
    ['− Operating expenses (freight, commission, admin, unallocated)', -d.operatingExpenses, 'opex'], ['= EBITDA', d.ebitda, null, 'b'],
    ['− Interest', -d.interest, 'interest'], ['− Taxes', -d.taxes, 'taxes'], ['− Depreciation', -d.depreciation, 'depreciation'], ['− Amortization', -d.amortization, 'amortization'],
    ['= Net profit', d.netProfit, null, 'b'],
  ];
  const rows = d.sources[src] || [];
  return (
    <div>
      <div className="kpis">
        <Kpi label="Revenue" value={d.revenue} format={(v) => money(v, true)} icon="Banknote" tone="primary" onClick={() => setSrc('sales')} />
        <Kpi label="COGS" value={d.cogs} format={(v) => money(v, true)} icon="Factory" tone="amber" onClick={() => setSrc('sales')} />
        <Kpi label="Gross Profit" value={d.grossProfit} format={(v) => money(v, true)} icon="TrendingUp" tone="accent" sub={`${d.grossMarginPct}% margin`} />
        <Kpi label="Operating Expenses" value={d.operatingExpenses} format={(v) => money(v, true)} icon="Coins" tone="violet" onClick={() => setSrc('opex')} />
        <Kpi label="EBITDA" value={d.ebitda} format={(v) => money(v, true)} icon="Landmark" tone="green" sub={`${d.ebitdaMarginPct}% of revenue`} />
        <Kpi label="Net Profit" value={d.netProfit} format={(v) => money(v, true)} icon="BadgeDollarSign" tone="blue" sub={`${d.netMarginPct}% net margin`} />
      </div>
      <div className="grid g2 mt">
        <Card title="Profit bridge" icon="ListOrdered">
          <table className="tbl tbl-mini"><tbody>
            {lines.map(([l, v, s, b]) => (
              <tr key={l} className={s ? 'click' : ''} onClick={() => s && setSrc(s)} style={src === s ? { background: 'var(--primary-50)' } : undefined}>
                <td style={{ fontWeight: b ? 700 : 400 }}>{l}{s && <Icon name="ChevronRight" size={13} style={{ marginLeft: 4, opacity: 0.5 }} />}</td>
                <td className="num" style={{ fontWeight: b ? 700 : 400, color: b ? tone(v) : undefined }}>{money(v)}</td>
              </tr>
            ))}
          </tbody></table>
          <div className="alert alert-info mt"><Icon name="Sigma" size={16} /> <span>EBITDA = Net profit {money(d.netProfit)} + Interest {money(d.interest)} + Taxes {money(d.taxes)} + Depreciation {money(d.depreciation)} + Amortization {money(d.amortization)} = <b>{money(d.ebitdaCheck)}</b></span></div>
          <div className="muted small mt">Revenue = issued invoices dated in the period. COGS = invoiced quantity × the job's cost of goods per piece (fabric, trims, CAD, cutting, sewing, finishing, washing, printing, packing, quality, labour, factory overhead – costed estimate where actual cost is not yet booked). Job production expenses are absorbed in COGS; interest, taxes, depreciation and amortization come from company expenses.</div>
        </Card>
        <Card title={`Source transactions – ${{ sales: 'Invoices & COGS', opex: 'Operating expenses', absorbed: 'Job costs in COGS', interest: 'Interest', taxes: 'Taxes', depreciation: 'Depreciation', amortization: 'Amortization' }[src]}`} icon="ReceiptText" pad={false}
          actions={<select value={src} onChange={(e) => setSrc(e.target.value)} style={{ width: 'auto', height: 30 }}>{['sales', 'opex', 'absorbed', 'interest', 'taxes', 'depreciation', 'amortization'].map((k) => <option key={k} value={k}>{k}</option>)}</select>}>
          {!rows.length ? <Empty title="No transactions in this period" /> : src === 'sales' ? (
            <div className="table-wrap" style={{ maxHeight: 440 }}>
              <table className="tbl tbl-mini"><thead><tr><th>Invoice</th><th>Job</th><th>Date</th><th className="num">Qty</th><th className="num">Revenue</th><th className="num">COGS / pc</th><th className="num">COGS</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r._id}><td><Link className="mono link" to={`/m/invoice/${r._id}`}>{r.invoiceNo}</Link></td><td><JobLink r={r} /><div className="muted small">{r.styleNo}</div></td><td>{fmtDate(r.invoiceDate)}</td>
                    <td className="num">{num(r.qty)}</td><td className="num">{money(r.revenue)}</td><td className="num" title={r.cogsBasis}>{num(r.cogsPerPc, 4)}</td><td className="num">{money(r.cogs)}</td></tr>
                ))}</tbody></table>
            </div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 440 }}>
              <table className="tbl tbl-mini"><thead><tr><th>Expense</th><th>Category</th><th>Job</th><th>Date</th><th className="num">Amount</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r._id}><td><Link className="mono link" to={`/m/expense/${r._id}`}>{r.refNo}</Link><div className="muted small">{r.description || r.note}</div></td><td>{r.category}</td><td><JobLink r={r} /></td><td>{fmtDate(r.date)}</td><td className="num">{money(r.amount)}</td></tr>
                ))}</tbody></table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------ Inventory → ITR → Holding period ------------------------------ */
function Inventory({ d, money }) {
  const [cat, setCat] = useState(null);
  const detail = useMemo(() => {
    if (!cat) return null;
    const c = d.closingDetail;
    if (['Work-in-Progress', 'Finished Goods'].includes(cat)) return { kind: 'jobs', rows: c.jobs.filter((j) => (cat === 'Work-in-Progress' ? j.wipValue : j.fgValue)) };
    if (cat === 'Yarn & Grey Fabric') return { kind: 'yarn', rows: [c.yarn] };
    return { kind: 'materials', rows: c.materials.filter((m) => m.category === cat), moves: d.movements.filter((m) => m.category === cat) };
  }, [cat, d]);
  return (
    <div>
      <div className="kpis">
        <Kpi label="Inventory Turnover (ITR)" value={d.itr === null ? 'n/a' : `${fmtNum(d.itr, 2)}x`} icon="RefreshCw" tone="primary" sub="COGS ÷ average inventory" />
        <Kpi label="Holding Period" value={daysTxt(d.holdingDays)} icon="Hourglass" tone="amber" sub={`closing ÷ daily COGS (${d.days}-day period)`} />
        <Kpi label="COGS" value={d.cogs} format={(v) => money(v, true)} icon="Factory" tone="violet" />
        <Kpi label="Opening Inventory" value={d.opening} format={(v) => money(v, true)} icon="Boxes" tone="blue" sub={d.openingDetail.at} />
        <Kpi label="Closing Inventory" value={d.closing} format={(v) => money(v, true)} icon="Boxes" tone="accent" sub={d.closingDetail.at} />
        <Kpi label="Average Inventory" value={d.average} format={(v) => money(v, true)} icon="Scale" tone="green" />
      </div>
      <Card className="mt" title="By inventory category" icon="Layers" pad={false}>
        <div className="card-body muted small">ITR = consumption ÷ average inventory · Holding days = closing inventory ÷ (consumption ÷ days). “n/a” = no stock or no consumption in the period (never shown as infinite). Click a category for the records behind it.</div>
        <div className="table-wrap">
          <table className="tbl tbl-mini">
            <thead><tr><th>Category</th><th className="num">Opening</th><th className="num">Closing</th><th className="num">Average</th><th className="num">Consumption</th><th>Basis</th><th className="num">ITR</th><th className="num">Per day</th><th className="num">Holding</th></tr></thead>
            <tbody>
              {d.categories.map((c) => (
                <tr key={c.category} className="click" onClick={() => setCat(c.category)} style={cat === c.category ? { background: 'var(--primary-50)' } : undefined}>
                  <td><b>{c.category}</b></td><td className="num">{money(c.opening)}</td><td className="num">{money(c.closing)}</td><td className="num">{money(c.average)}</td>
                  <td className="num">{money(c.consumption)}</td><td className="muted small">{c.basis}</td><td className="num">{ratioX(c.itr)}</td><td className="num">{money(c.dailyConsumption)}</td><td className="num">{daysTxt(c.holdingDays)}</td>
                </tr>
              ))}
              <tr><td><b>Total inventory</b></td><td className="num"><b>{money(d.opening)}</b></td><td className="num"><b>{money(d.closing)}</b></td><td className="num"><b>{money(d.average)}</b></td><td className="num"><b>{money(d.consumption)}</b></td><td className="muted small">{d.basis}</td><td className="num"><b>{ratioX(d.itr)}</b></td><td className="num">{money(d.dailyConsumption)}</td><td className="num"><b>{daysTxt(d.holdingDays)}</b></td></tr>
            </tbody>
          </table>
        </div>
      </Card>
      {detail && (
        <Card className="mt" title={`${cat} at ${d.closingDetail.at}`} icon="Search" pad={false} actions={<button className="btn btn-sm btn-ghost" onClick={() => setCat(null)}><Icon name="X" size={14} /></button>}>
          {detail.kind === 'jobs' && (detail.rows.length ? (
            <table className="tbl tbl-mini"><thead><tr><th>Job</th><th>Buyer / Style</th>{cat === 'Work-in-Progress' ? <><th className="num">Cut, not sewn</th><th className="num">Cost / pc</th><th className="num">Sewn, not finished</th><th className="num">Cost / pc</th><th className="num">WIP value</th></> : <><th className="num">Finished, not shipped</th><th className="num">Cost / pc</th><th className="num">FG value</th></>}</tr></thead>
              <tbody>{detail.rows.map((j) => (
                <tr key={j.jobNo}><td><JobLink r={j} /></td><td>{j.buyerName}<div className="muted small">{j.styleNo}</div></td>
                  {cat === 'Work-in-Progress' ? <><td className="num">{num(j.wipCut)}</td><td className="num">{num(j.cutCostPc, 4)}</td><td className="num">{num(j.wipSew)}</td><td className="num">{num(j.sewCostPc, 4)}</td><td className="num">{money(j.wipValue)}</td></>
                    : <><td className="num">{num(j.fgQty)}</td><td className="num">{num(j.fgCostPc, 4)}</td><td className="num">{money(j.fgValue)}</td></>}</tr>
              ))}</tbody></table>
          ) : <Empty title="Nothing in this category" />)}
          {detail.kind === 'yarn' && <div className="card-body">Yarn {fmtNum(detail.rows[0].yarnKg, 2)} kg · grey / in-process fabric {fmtNum(detail.rows[0].greyKg, 2)} kg · value {money(detail.rows[0].value)} <Link to="/stock" className="small">Open stock reports</Link></div>}
          {detail.kind === 'materials' && (
            <div className="grid g2" style={{ padding: 12 }}>
              <div>
                <div className="form-section-title">Closing stock by booking</div>
                {detail.rows.length ? <table className="tbl tbl-mini"><thead><tr><th>Booking</th><th>Item</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
                  <tbody>{detail.rows.map((m) => <tr key={m.recordId}><td><Link className="mono link" to={`/m/${m.module}/${m.recordId}`}>{m.refNo}</Link><div className="muted small"><JobLink r={m} /></div></td><td>{m.item}</td><td className="num">{num(m.qty, 2)} {m.unit}</td><td className="num">{money(m.value)}</td></tr>)}</tbody></table> : <Empty title="No stock" />}
              </div>
              <div>
                <div className="form-section-title">Movements in the period (stock ledger)</div>
                {detail.moves.length ? <div className="table-wrap" style={{ maxHeight: 360 }}><table className="tbl tbl-mini"><thead><tr><th>Date</th><th>Booking</th><th>In / Out</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
                  <tbody>{detail.moves.map((m) => <tr key={m._id}><td>{m.date}</td><td><Link className="mono link" to={`/m/${m.module}/${m.recordId}`}>{m.refNo}</Link><div className="muted small">{m.note}</div></td><td><Badge tone={m.direction === 'in' ? 'green' : 'amber'} dot={false}>{m.direction === 'in' ? 'Received' : 'Issued'}</Badge></td><td className="num">{num(m.qty, 2)}</td><td className="num">{money(m.value)}</td></tr>)}</tbody></table></div> : <Empty title="No movements in this period" />}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* ------------------------------ Product / Style ROI ------------------------------ */
function Roi({ d, money, by, onBy }) {
  const [open, setOpen] = useState(null);
  return (
    <div>
      <div className="kpis">
        <Kpi label={`ROI (${d.label})`} value={pctTxt(d.roiPct)} icon="Percent" tone="green" sub="actual profit ÷ actual cost" />
        <Kpi label="Sales Revenue" value={d.revenue} format={(v) => money(v, true)} icon="Banknote" tone="primary" />
        <Kpi label="Actual Cost" value={d.cost} format={(v) => money(v, true)} icon="Coins" tone="amber" />
        <Kpi label="Actual Profit" value={d.profit} format={(v) => money(v, true)} icon="TrendingUp" tone="accent" sub={`${d.marginPct}% margin`} />
      </div>
      <Card className="mt" title="Return on investment" icon="ChartPie" pad={false}
        actions={<select value={by} onChange={(e) => onBy(e.target.value)} style={{ width: 'auto', height: 30 }}>{Object.entries(d.dimensions).map(([k, l]) => <option key={k} value={k}>By {l}</option>)}</select>}>
        <div className="card-body muted small">Jobs invoiced in the period. Sales revenue → actual cost (all cost heads, costed estimate where nothing is booked yet) → actual profit → ROI. Colour splits each job by its colour / size breakdown. Click a row for its jobs.</div>
        {!d.rows.length ? <Empty title="No invoiced jobs in this period" /> : (
          <div className="table-wrap">
            <table className="tbl tbl-mini">
              <thead><tr><th>{d.label}</th><th className="num">Jobs</th><th className="num">Order qty</th><th className="num">Shipped</th><th className="num">Revenue</th><th className="num">Actual cost</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">ROI</th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <Fragment key={r.key}>
                  <tr className="click" onClick={() => setOpen(open === r.key ? null : r.key)}>
                    <td><Icon name={open === r.key ? 'ChevronDown' : 'ChevronRight'} size={13} /> <b>{r.key}</b></td><td className="num">{r.jobs.length}</td><td className="num">{num(r.orderQty)}</td><td className="num">{num(r.shippedQty)}</td>
                    <td className="num">{money(r.revenue)}</td><td className="num">{money(r.cost)}</td><td className="num" style={{ color: tone(r.profit), fontWeight: 650 }}>{money(r.profit)}</td><td className="num">{pctTxt(r.marginPct)}</td><td className="num"><b>{pctTxt(r.roiPct)}</b></td>
                  </tr>
                  {open === r.key && r.jobs.map((j) => (
                    <tr key={`${r.key}-${j.jobNo}`} style={{ background: 'var(--surface-2)' }}>
                      <td style={{ paddingLeft: 28 }}><JobLink r={j} /> <span className="muted small">{j.buyerName} · {j.styleNo} · PO {j.poNo}{j.share < 1 ? ` · ${fmtNum(j.share * 100, 1)}%` : ''}</span></td>
                      <td /><td /><td /><td className="num">{money(j.revenue)}</td><td className="num">{money(j.cost)}</td><td className="num">{money(j.profit)}</td><td /><td className="num">{pctTxt(j.roiPct)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------ Job profitability & cost variance ------------------------------ */
function Variance({ d, money }) {
  const nav = useNavigate();
  return (
    <div>
      <div className="kpis">
        <Kpi label="Estimated Cost" value={d.estimated} format={(v) => money(v, true)} icon="Calculator" tone="primary" sub="costing × order qty" />
        <Kpi label="Actual Cost" value={d.actual} format={(v) => money(v, true)} icon="Coins" tone="amber" />
        <Kpi label="Cost Variance" value={d.variance} format={(v) => money(v, true)} icon="Scale" tone={d.variance > 0 ? 'red' : 'green'} sub={d.variance > 0 ? 'over estimate' : 'within estimate'} />
        <Kpi label="Quality / Rejection Loss" value={d.qualityLoss.value} format={(v) => money(v, true)} icon="XCircle" tone="red" sub={`${fmtNum(d.qualityLoss.rejectedQty)} rejected · ${fmtNum(d.qualityLoss.reworkQty)} rework`} />
      </div>
      <Card className="mt" title="Production cost variance by head" icon="Scale" pad={false}>
        <table className="tbl tbl-mini"><thead><tr><th>Cost head</th><th className="num">Estimated</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">Variance %</th></tr></thead>
          <tbody>{d.heads.map((h) => <tr key={h.key}><td>{h.label}</td><td className="num">{money(h.estimated)}</td><td className="num">{money(h.actual)}</td><td className="num" style={{ color: varTone(h.variance) }}>{money(h.variance)}</td><td className="num">{pctTxt(h.variancePct)}</td></tr>)}</tbody></table>
      </Card>
      <Card className="mt" title="Order / job profitability" icon="Table" pad={false}>
        {!d.jobs.length ? <Empty title="No active jobs in this period" /> : (
          <div className="table-wrap">
            <table className="tbl tbl-mini">
              <thead><tr><th>Job</th><th>Buyer / Style</th><th>PO</th><th className="num">Order qty</th><th className="num">Shipped</th><th className="num">Sales</th><th className="num">Est. cost</th><th className="num">Actual cost</th><th className="num">Est. profit</th><th className="num">Actual profit</th><th className="num">Profit var.</th><th className="num">ROI</th><th className="num">Rejection loss</th><th>Status</th></tr></thead>
              <tbody>{d.jobs.map((j) => (
                <tr key={j.jobNo} className="click" onClick={() => nav(`/jobs/${j.jobNo}`)}>
                  <td className="mono link">{j.jobNo}</td><td>{j.buyerName}<div className="muted small">{j.styleNo}</div></td><td>{j.poNo}</td><td className="num">{num(j.orderQty)}</td><td className="num">{num(j.shippedQty)}</td>
                  <td className="num">{money(j.salesValue)}</td><td className="num">{money(j.estimatedCost)}</td><td className="num">{money(j.actualCost)}</td><td className="num">{money(j.estimatedProfit)}</td>
                  <td className="num" style={{ color: tone(j.actualProfit), fontWeight: 650 }}>{money(j.actualProfit)}</td><td className="num" style={{ color: tone(j.profitVariance) }}>{money(j.profitVariance)}</td><td className="num">{pctTxt(j.roiPct)}</td><td className="num">{money(j.rejectionLoss)}</td><td><StatusBadge status={j.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------ Fabric · production · shipment ------------------------------ */
function Operations({ d, money }) {
  const [view, setView] = useState('fabric');
  const f = d.fabric; const p = d.production; const s = d.shipment;
  return (
    <div>
      <div className="seg mb" style={{ flexWrap: 'wrap' }}>{[['fabric', 'Fabric performance'], ['production', 'Production performance'], ['shipment', 'Shipment performance']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>
      {view === 'fabric' && <div className="kpis">
        {[['Booked', f.booked], ['Received', f.received], ['Issued', f.issued], ['Consumed', f.consumed], ['Balance', f.balance], ['Wastage', f.wastage], ['Shortage', f.shortage], ['Excess', f.excess]].map(([l, v], i) => <Kpi key={l} label={`Fabric ${l}`} value={v} decimals={1} icon="Layers" tone={['primary', 'accent', 'blue', 'violet', 'green', 'amber', 'red', 'amber'][i]} />)}
        <Kpi label="Fabric Cost Variance" value={f.costVariance} format={(v) => money(v, true)} icon="Scale" tone={f.costVariance > 0 ? 'red' : 'green'} />
      </div>}
      {view === 'production' && <div className="kpis">
        <Kpi label="Planned Qty" value={p.planned} icon="Target" tone="primary" /><Kpi label="Produced Qty" value={p.produced} icon="Spline" tone="green" />
        <Kpi label="Achievement" value={p.achievementPct} format={(v) => `${fmtNum(v, 1)}%`} icon="Gauge" tone="accent" /><Kpi label="WIP" value={p.wip} icon="Boxes" tone="amber" />
        <Kpi label="Rejection" value={p.rejection} icon="XCircle" tone="red" /><Kpi label="Rework" value={p.rework} icon="Wrench" tone="blue" /><Kpi label="Delayed Jobs" value={p.delayedJobs} icon="AlarmClock" tone="red" />
      </div>}
      {view === 'shipment' && <div className="kpis">
        <Kpi label="Order Qty" value={s.orderQty} icon="ClipboardCheck" tone="primary" /><Kpi label="Packed" value={s.packed} icon="PackageCheck" tone="accent" /><Kpi label="Inspected" value={s.inspected} icon="ShieldCheck" tone="violet" />
        <Kpi label="Shipped" value={s.shipped} icon="Ship" tone="green" /><Kpi label="Balance" value={s.balance} icon="Hourglass" tone="amber" />
        <Kpi label="On-time Shipment" value={s.onTimePct === null ? 'n/a' : `${fmtNum(s.onTimePct, 1)}%`} icon="AlarmClock" tone="blue" /><Kpi label="Shipment Value" value={s.value} format={(v) => money(v, true)} icon="Banknote" tone="primary" />
      </div>}
      <Card className="mt" title="By job" icon="Table" pad={false}>
        {!d.rows.length ? <Empty title="No active jobs in this period" /> : (
          <div className="table-wrap">
            <table className="tbl tbl-mini">
              {view === 'fabric' && <><thead><tr><th>Job</th><th>Style</th><th className="num">Booked</th><th className="num">Received</th><th className="num">Issued</th><th className="num">Consumed</th><th className="num">Balance</th><th className="num">Wastage</th><th className="num">Shortage</th><th className="num">Excess</th><th className="num">Cost var.</th></tr></thead>
                <tbody>{d.rows.map((r) => <tr key={r.jobNo}><td><JobLink r={r} /></td><td>{r.styleNo}</td>{['booked', 'received', 'issued', 'consumed', 'balance', 'wastage', 'shortage', 'excess'].map((k) => <td key={k} className="num">{num(r.fabric[k], 1)}</td>)}<td className="num" style={{ color: varTone(r.fabric.costVariance) }}>{money(r.fabric.costVariance)}</td></tr>)}</tbody></>}
              {view === 'production' && <><thead><tr><th>Job</th><th>Style</th><th className="num">Planned</th><th className="num">Cut</th><th className="num">Produced</th><th className="num">Achievement</th><th className="num">Efficiency</th><th className="num">WIP</th><th className="num">Rejection</th><th className="num">Rework</th><th className="num">Delay</th></tr></thead>
                <tbody>{d.rows.map((r) => <tr key={r.jobNo}><td><JobLink r={r} /></td><td>{r.styleNo}</td><td className="num">{num(r.production.planned)}</td><td className="num">{num(r.production.cut)}</td><td className="num">{num(r.production.produced)}</td><td className="num">{fmtNum(r.production.achievementPct, 1)}%</td><td className="num">{fmtNum(r.production.efficiencyPct, 1)}%</td><td className="num">{num(r.production.wip)}</td><td className="num">{num(r.production.rejection)}</td><td className="num">{num(r.production.rework)}</td><td className="num">{r.production.delayDays ? <Badge tone="red" dot={false}>{r.production.delayDays}d</Badge> : '—'}</td></tr>)}</tbody></>}
              {view === 'shipment' && <><thead><tr><th>Job</th><th>Style</th><th className="num">Order</th><th className="num">Packed</th><th className="num">Inspected</th><th className="num">Shipped</th><th className="num">Balance</th><th>Ship date</th><th>On time</th><th className="num">Delay</th><th className="num">Value</th></tr></thead>
                <tbody>{d.rows.map((r) => <tr key={r.jobNo}><td><JobLink r={r} /></td><td>{r.styleNo}</td><td className="num">{num(r.orderQty)}</td><td className="num">{num(r.shipment.packed)}</td><td className="num">{num(r.shipment.inspected)}</td><td className="num">{num(r.shipment.shipped)}</td><td className="num">{num(r.shipment.balance)}</td><td>{fmtDate(r.shipment.shipDate)}</td><td>{r.shipment.onTime === null ? '—' : <Badge tone={r.shipment.onTime ? 'green' : 'red'} dot={false}>{r.shipment.onTime ? 'Yes' : 'Late'}</Badge>}</td><td className="num">{r.shipment.delayDays ? `${r.shipment.delayDays}d` : '—'}</td><td className="num">{money(r.shipment.value)}</td></tr>)}</tbody></>}
            </table>
          </div>
        )}
      </Card>
      {view === 'production' && d.lines.length > 0 && (
        <Card className="mt" title="Line efficiency" icon="Rows3" pad={false}>
          <table className="tbl tbl-mini"><thead><tr><th>Line</th><th className="num">Target</th><th className="num">Output</th><th className="num">Efficiency</th></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.line}><td>{l.line}</td><td className="num">{num(l.target)}</td><td className="num">{num(l.output)}</td><td className="num">{fmtNum(l.efficiencyPct, 1)}%</td></tr>)}</tbody></table>
        </Card>
      )}
    </div>
  );
}
