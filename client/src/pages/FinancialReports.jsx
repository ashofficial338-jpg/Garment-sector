/**
 * Financial Reports – revenue, expenses, purchases, profit, cash, tax, inventory and outstanding balances
 * per day / week / month / quarter / year, compared with the previous period, with Excel and PDF export.
 * Every figure comes from /api/analytics/financial (calculated on the server from database records – the
 * same calculation as Management Analytics); the PDF is built from the same response, so all three agree.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ComposedChart, BarChart, LineChart, Bar, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from 'recharts';
import { api, errMsg } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Card, Kpi, Loading, Empty, Icon } from '../components/ui.jsx';
import { UnitScope, useUnitName } from '../components/UnitScope.jsx';
import { ChartBox, ChartTooltip, ChartLegend, useChartTheme } from '../components/Charts.jsx';
import { fmtNum, fmtCurrency, fmtCompact } from '../utils/format.js';
import { financialPdf, SECTION_LABELS } from '../utils/financialPdf.js';

const GRAINS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['quarter', 'Quarterly'], ['year', 'Yearly']];
const iso = (d) => d.toISOString().slice(0, 10);
function preset(key) {
  const now = new Date();
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const start = { month: new Date(Date.UTC(y, m, 1)), quarter: new Date(Date.UTC(y, m - 2, 1)), ytd: new Date(Date.UTC(y, 0, 1)), '12m': new Date(Date.UTC(y, m - 11, 1)) }[key];
  return { from: iso(start), to: iso(now) };
}
const SECTIONS_KEY = 'financialReports.sections';
const loadSections = () => {
  try { const v = JSON.parse(localStorage.getItem(SECTIONS_KEY)); if (Array.isArray(v) && v.length) return v; } catch { /* storage unavailable */ }
  return Object.keys(SECTION_LABELS);
};
const tone = (v) => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : undefined);

export default function FinancialReports() {
  const { user, can } = useAuth();
  const { toast } = useFeedback();
  const unitName = useUnitName();
  const [sp, setSp] = useSearchParams();
  const def = preset('12m');
  const q = { from: sp.get('from') || def.from, to: sp.get('to') || def.to, unit: sp.get('unit') || '', grain: sp.get('grain') || 'month' };
  const set = (patch) => setSp(Object.fromEntries(Object.entries({ ...q, ...patch }).filter(([, v]) => v)), { replace: true });
  const [data, setData] = useState(null);
  const [sections, setSections] = useState(loadSections);
  const [busy, setBusy] = useState(null); // { kind, pct }
  const canExport = can('analytics', 'export') || can('reports', 'export');

  useEffect(() => {
    setData(null);
    api.get('/analytics/financial', { params: { from: q.from, to: q.to, unit: q.unit || undefined, grain: q.grain } })
      .then((r) => setData(r.data)).catch((e) => setData({ error: errMsg(e) }));
  }, [q.from, q.to, q.unit, q.grain]);

  const toggle = (k) => {
    const next = sections.includes(k) ? sections.filter((x) => x !== k) : [...sections, k];
    setSections(next);
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const scopeLabel = q.unit === 'ALL' ? 'Both units (consolidated)' : unitName(q.unit || user.unit.code);
  const cur = data?.currency || 'USD';
  const money = (v, compact) => fmtCurrency(v, cur, compact);

  async function exportExcel() {
    if (!sections.length) { toast('Choose at least one section to export', 'err'); return; }
    setBusy({ kind: 'excel', pct: 0 });
    try {
      const res = await api.get('/analytics/financial/export', {
        params: { from: q.from, to: q.to, unit: q.unit || undefined, grain: q.grain, sections: sections.join(',') }, responseType: 'blob',
        onDownloadProgress: (e) => e.total && setBusy({ kind: 'excel', pct: Math.round((e.loaded / e.total) * 100) }),
      });
      const name = decodeURIComponent((res.headers['content-disposition']?.match(/filename="?([^"]+)"?/) || [])[1] || 'Financial-Report.xlsx');
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = href; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
      toast(`Excel workbook downloaded (${sections.length} sheets)`);
    } catch (e) {
      // error bodies arrive as a blob when responseType is blob
      let msg = errMsg(e);
      try { const t = await e.response?.data?.text?.(); if (t) msg = JSON.parse(t).message || msg; } catch { /* keep msg */ }
      toast(msg, 'err');
    } finally { setBusy(null); }
  }

  function exportPdf(preview) {
    if (!sections.length) { toast('Choose at least one section to export', 'err'); return; }
    setBusy({ kind: preview ? 'preview' : 'pdf' });
    // let the button state paint before the (synchronous) PDF build
    setTimeout(() => {
      try {
        const blob = financialPdf(data, { sections, scopeLabel, generatedBy: user.name });
        const href = URL.createObjectURL(blob);
        if (preview) window.open(href, '_blank', 'noopener');
        else { const a = document.createElement('a'); a.href = href; a.download = `Financial-Report-${data.from}-to-${data.to}.pdf`; a.click(); toast('PDF report downloaded'); }
        setTimeout(() => URL.revokeObjectURL(href), 60000);
      } catch (e) { toast(`Could not build the PDF: ${e.message}`, 'err'); } finally { setBusy(null); }
    }, 30);
  }

  return (
    <div>
      <PageHead title="Financial Reports" icon="FileSpreadsheet" subtitle={`${scopeLabel} · ${q.from} → ${q.to} · calculated from invoices, payments, supplier bills, expenses and stock records`}>
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
          <select value={q.grain} onChange={(e) => set({ grain: e.target.value })} style={{ width: 'auto' }} aria-label="Group by">
            {GRAINS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>

      {!data ? <Loading /> : data.error ? (
        <Empty icon="AlertTriangle" title="Could not load the financial report">{data.error}</Empty>
      ) : data.empty ? (
        <Card>
          <Empty icon="FileWarning" title={`No financial transactions in ${scopeLabel} for ${data.period}`}>
            Revenue, expenses and purchases appear here once invoices, supplier bills, expenses or payments are recorded.
            <div className="row-wrap" style={{ justifyContent: 'center', marginTop: 12 }}>
              {can('invoice', 'create') && <Link className="btn btn-sm" to="/m/invoice">Add an invoice</Link>}
              {can('supplierBill', 'create') && <Link className="btn btn-sm" to="/m/supplierBill">Add a supplier bill</Link>}
              {can('expense', 'create') && <Link className="btn btn-sm" to="/m/expense">Add an expense</Link>}
              <button className="btn btn-sm" onClick={() => set(preset('12m'))}>Show last 12 months</button>
            </div>
          </Empty>
        </Card>
      ) : (
        <Report d={data} money={money} />
      )}

      {data && !data.error && !data.empty && (
        <Card title="Export" icon="Download" className="mt">
          {!canExport ? <div className="muted small">Exporting needs the Export permission on Management Analytics or the Report Center – ask an administrator.</div> : (
            <>
              <div className="small muted mb">Choose the sections to include. Excel gets one sheet per section with live formulas, totals, filters and highlighted losses; the PDF adds summary cards and charts.</div>
              <div className="row-wrap mb">
                {Object.entries(SECTION_LABELS).map(([k, l]) => (
                  <label key={k} className="check"><input type="checkbox" checked={sections.includes(k)} onChange={() => toggle(k)} />{l}</label>
                ))}
              </div>
              <div className="row-wrap">
                <button className="btn btn-sm" onClick={() => { const all = Object.keys(SECTION_LABELS); setSections(all); try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ } }}>Select all</button>
                <div className="grow" />
                <button className="btn" disabled={!!busy} onClick={() => exportPdf(true)}><Icon name="Eye" size={16} />{busy?.kind === 'preview' ? 'Building…' : 'Preview PDF'}</button>
                <button className="btn" disabled={!!busy} onClick={() => exportPdf(false)}><Icon name="FileText" size={16} />{busy?.kind === 'pdf' ? 'Building…' : 'Download PDF'}</button>
                <button className="btn btn-primary" disabled={!!busy} onClick={exportExcel}><Icon name="FileSpreadsheet" size={16} />{busy?.kind === 'excel' ? `Preparing… ${busy.pct ? `${busy.pct}%` : ''}` : 'Download Excel'}</button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

/** "▲ 12.4% vs previous period" */
function Delta({ c, invert }) {
  if (!c) return null;
  if (c.pct === null) return <span className="muted">no previous-period figure</span>;
  const good = invert ? c.abs < 0 : c.abs > 0;
  return <span style={{ color: c.abs === 0 ? undefined : good ? 'var(--green)' : 'var(--red)' }}>{c.abs >= 0 ? '▲' : '▼'} {fmtNum(Math.abs(c.pct), 1)}% vs previous</span>;
}

function Report({ d, money }) {
  const t = useChartTheme();
  const h = d.headline; const c = d.comparison;
  const unitLabel = d.grainLabel.replace(/ly$/, '').replace('Dai', 'Day');
  const topStyles = useMemo(() => d.performance.styles.slice(0, 8).map((s) => ({ ...s, name: s.key })), [d]);
  const periodTick = (p) => (d.grain === 'day' ? p.slice(5) : d.grain === 'week' ? p.slice(7) : p);
  return (
    <>
      {d.currencies?.length > 1 && <div className="alert alert-warn mb"><Icon name="AlertTriangle" size={16} /> Transactions in {d.currencies.join(', ')} are summed as recorded and shown in {d.currency}.</div>}
      <div className="kpis">
        <Kpi label="Revenue" value={h.revenue} format={(v) => money(v, true)} icon="Banknote" tone="primary" sub={<Delta c={c.revenue} />} />
        <Kpi label="Expenses" value={h.expenses} format={(v) => money(v, true)} icon="Coins" tone="amber" sub={<Delta c={c.expenses} invert />} />
        <Kpi label="Purchases" value={h.purchases} format={(v) => money(v, true)} icon="ReceiptText" tone="violet" sub={<Delta c={c.purchases} invert />} />
        <Kpi label="Net Profit" value={h.netProfit} format={(v) => money(v, true)} icon="TrendingUp" tone="green" sub={<Delta c={c.netProfit} />} />
        <Kpi label="Net Margin" value={`${fmtNum(h.netMarginPct, 1)}%`} icon="Percent" tone="blue" sub={`previous ${fmtNum(d.previousHeadline.netMarginPct, 1)}%`} />
        <Kpi label="Receivables" value={d.receivables.total} format={(v) => money(v, true)} icon="Wallet" tone="accent" sub={`${money(d.receivables.overdue, true)} overdue`} />
      </div>
      <div className="small muted mt">Compared with {d.previous}. Expenses = cost of goods sold + operating expenses + interest, taxes and D&A. Purchases are supplier bills (they reach expenses through cost of goods when goods are invoiced, so they are not added twice).</div>

      <div className="grid g2 mt">
        <Card title={`Revenue vs expenses · ${d.grainLabel.toLowerCase()}`} icon="BarChart3" className="span2">
          <ChartBox height={300}>
            <ComposedChart data={d.series} barGap={2}>
              <CartesianGrid vertical={false} stroke={t.grid} />
              <XAxis dataKey="period" tickLine={false} axisLine={false} tickFormatter={periodTick} minTickGap={8} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={52} />
              <ChartTooltip format={(v) => money(v)} /><ChartLegend />
              <ReferenceLine y={0} stroke={t.muted} />
              <Bar dataKey="revenue" name="Revenue" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={22} />
              <Bar dataKey="expenses" name="Expenses" fill={t.series[3]} radius={[4, 4, 0, 0]} maxBarSize={22} />
              <Line type="monotone" dataKey="netProfit" name="Net profit" stroke={t.series[2]} strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: t.surface }} />
            </ComposedChart>
          </ChartBox>
        </Card>
        <Card title="Profit growth (cumulative net profit)" icon="TrendingUp">
          <ChartBox>
            <LineChart data={d.series}>
              <CartesianGrid vertical={false} stroke={t.grid} />
              <XAxis dataKey="period" tickLine={false} axisLine={false} tickFormatter={periodTick} minTickGap={8} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={52} />
              <ChartTooltip format={(v) => money(v)} />
              <ReferenceLine y={0} stroke={t.muted} />
              <Line type="monotone" dataKey="cumulativeProfit" name="Cumulative net profit" stroke={t.series[0]} strokeWidth={2} dot={false} />
            </LineChart>
          </ChartBox>
        </Card>
        <Card title="Cash in vs cash out" icon="HandCoins">
          <ChartBox>
            <BarChart data={d.series} barGap={2}>
              <CartesianGrid vertical={false} stroke={t.grid} />
              <XAxis dataKey="period" tickLine={false} axisLine={false} tickFormatter={periodTick} minTickGap={8} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={52} />
              <ChartTooltip format={(v) => money(v)} /><ChartLegend />
              <Bar dataKey="receipts" name="Received from buyers" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="supplierPayments" name="Paid to suppliers" fill={t.series[1]} radius={[4, 4, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ChartBox>
        </Card>
        <Card title="Top styles by revenue" icon="Shirt">
          {topStyles.length ? (
            <ChartBox height={Math.max(180, topStyles.length * 34)}>
              <BarChart data={topStyles} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid horizontal={false} stroke={t.grid} />
                <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={fmtCompact} />
                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={96} />
                <ChartTooltip format={(v) => money(v)} />
                <Bar dataKey="revenue" name="Revenue" fill={t.series[0]} radius={[0, 4, 4, 0]} maxBarSize={18} />
              </BarChart>
            </ChartBox>
          ) : <Empty title="No invoiced styles in this period" />}
        </Card>
        <SalesTable title="Garment types" icon="Layers" rows={d.performance.garmentTypes} money={money} />
        <SalesTable title="Buyers" icon="Building2" rows={d.performance.buyers} money={money} />
        <Card title="Outstanding balances (end of period)" icon="Wallet">
          <table className="tbl tbl-mini"><thead><tr><th>Aging</th><th className="num">Receivable</th><th className="num">Payable</th></tr></thead><tbody>
            {['Not due', '1–30 days', '31–60 days', '61–90 days', '90+ days', 'No due date'].map((b) => {
              const rcv = d.receivables.aging.find((x) => x.bucket === b); const pay = d.payables.aging.find((x) => x.bucket === b);
              return (rcv || pay) ? <tr key={b}><td>{b}</td><td className="num">{money(rcv?.amount || 0)}</td><td className="num">{money(pay?.amount || 0)}</td></tr> : null;
            })}
            <tr><td><b>Total</b></td><td className="num"><b>{money(d.receivables.total)}</b></td><td className="num"><b>{money(d.payables.total)}</b></td></tr>
          </tbody></table>
          <div className="small muted mt">Cash this period: received {money(d.cash.receipts)} · paid to suppliers {money(d.cash.supplierPayments)} · net <b style={{ color: tone(d.cash.net) }}>{money(d.cash.net)}</b></div>
        </Card>
        <Card title="Inventory & tax" icon="Warehouse">
          <table className="tbl tbl-mini"><thead><tr><th>Category</th><th className="num">Opening</th><th className="num">Closing</th><th className="num">Turnover</th></tr></thead><tbody>
            {d.inventory.categories.filter((x) => x.opening || x.closing).map((x) => <tr key={x.category}><td>{x.category}</td><td className="num">{money(x.opening)}</td><td className="num">{money(x.closing)}</td><td className="num">{x.itr === null ? 'n/a' : `${fmtNum(x.itr, 2)}x`}</td></tr>)}
            <tr><td><b>Total</b></td><td className="num"><b>{money(d.inventory.opening)}</b></td><td className="num"><b>{money(d.inventory.closing)}</b></td><td className="num">{d.inventory.itr === null ? 'n/a' : `${fmtNum(d.inventory.itr, 2)}x`}</td></tr>
          </tbody></table>
          <div className="small muted mt">Input tax on supplier bills: <b>{money(d.tax.inputTotal)}</b> ({d.tax.input.map((x) => `${x.taxPct}%: ${money(x.tax)}`).join(' · ') || 'none'}). {d.tax.note}</div>
        </Card>
      </div>

      <Card title={`${d.grainLabel} profit & loss`} icon="Table" className="mt" pad={false}>
        <table className="tbl tbl-mini">
          <thead><tr><th>{unitLabel}</th><th className="num">Revenue</th><th className="num">COGS</th><th className="num">Operating exp.</th><th className="num">Interest, tax, D&A</th><th className="num">Net profit</th><th className="num">Margin</th><th className="num">Purchases</th><th className="num">Net cash</th></tr></thead>
          <tbody>
            {d.series.map((r) => (
              <tr key={r.period}>
                <td className="mono">{r.period}</td><td className="num">{money(r.revenue)}</td><td className="num">{money(r.cogs)}</td><td className="num">{money(r.operatingExpenses)}</td><td className="num">{money(r.financeCosts)}</td>
                <td className="num" style={{ color: tone(r.netProfit), fontWeight: 600 }}>{money(r.netProfit)}</td><td className="num">{r.revenue ? `${fmtNum(r.netMarginPct, 1)}%` : '—'}</td>
                <td className="num">{money(r.purchases)}</td><td className="num" style={{ color: tone(r.netCashFlow) }}>{money(r.netCashFlow)}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td><td className="num">{money(h.revenue)}</td><td className="num">{money(h.cogs)}</td><td className="num">{money(h.operatingExpenses)}</td><td className="num">{money(h.expenses - h.cogs - h.operatingExpenses)}</td>
              <td className="num" style={{ color: tone(h.netProfit) }}>{money(h.netProfit)}</td><td className="num">{fmtNum(h.netMarginPct, 1)}%</td><td className="num">{money(h.purchases)}</td><td className="num" style={{ color: tone(d.cash.net) }}>{money(d.cash.net)}</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function SalesTable({ title, icon, rows, money }) {
  return (
    <Card title={title} icon={icon}>
      {rows.length ? (
        <table className="tbl tbl-mini"><thead><tr><th>{title.replace(/s$/, '')}</th><th className="num">Qty</th><th className="num">Revenue</th><th className="num">Gross profit</th><th className="num">Margin</th></tr></thead><tbody>
          {rows.slice(0, 8).map((r) => (
            <tr key={r.key}><td>{r.label}</td><td className="num">{fmtNum(r.qty)}</td><td className="num">{money(r.revenue)}</td><td className="num" style={{ color: tone(r.grossProfit) }}>{money(r.grossProfit)}</td><td className="num">{fmtNum(r.marginPct, 1)}%</td></tr>
          ))}
        </tbody></table>
      ) : <Empty title="No invoices in this period" />}
    </Card>
  );
}
