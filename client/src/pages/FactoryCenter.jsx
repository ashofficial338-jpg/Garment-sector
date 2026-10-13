/**
 * Factory Control Center – production (hourly → daily), WIP, quality, finished goods, HR & labour, factory expenses,
 * cost of quality, profit & loss with cash flow, Main / Sub Job history and integrity checks, for one unit or both.
 * Every figure comes from /api/factory (calculated on the server from saved transactions); every table row links
 * back to the record it came from.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { api, errMsg, download } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Card, Kpi, Tabs, Loading, Empty, Badge, Icon, StatusBadge } from '../components/ui.jsx';
import { UnitScope, useUnitName } from '../components/UnitScope.jsx';
import { ChartBox, ChartTooltip, ChartLegend, useChartTheme } from '../components/Charts.jsx';
import { fmtNum, fmtCompact } from '../utils/format.js';

const iso = (d) => d.toISOString().slice(0, 10);
const PRESETS = [['today', 'Today', 0], ['7d', '7 days', 6], ['30d', '30 days', 29], ['90d', '90 days', 89]];
const presetRange = (days) => { const to = new Date(); return { from: iso(new Date(to.getTime() - days * 86400000)), to: iso(to) }; };
const MONTH_START = () => { const n = new Date(); return iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1))); };

const TABS = [
  { key: 'overview', label: 'Overview', filters: ['dates'] },
  { key: 'production', label: 'Production', report: 'production', filters: ['dates', 'department', 'line', 'shift', 'job'] },
  { key: 'wip', label: 'WIP & Flow', report: 'wip', filters: ['job', 'include'] },
  { key: 'quality', label: 'Quality', report: 'quality', filters: ['dates', 'stage', 'department', 'inspector', 'defect', 'job'] },
  { key: 'fg', label: 'Finished Goods', report: 'fg', filters: ['job', 'include'] },
  { key: 'hr', label: 'HR & Labour', report: 'hr', money: 'hr', filters: ['dates', 'section'] },
  { key: 'expenses', label: 'Factory Expenses', report: 'expenses', money: 'expenses', filters: ['dates', 'category', 'department'] },
  { key: 'copq', label: 'Cost of Quality', report: 'copq', money: 'pnl', filters: ['job'] },
  { key: 'pnl', label: 'Profit & Loss', report: 'pnl', money: 'pnl', filters: ['dates', 'bucket', 'job', 'include'] },
  { key: 'job', label: 'Job History', filters: [] },
  { key: 'integrity', label: 'Integrity Checks', filters: [] },
];

/** KPI tiles per report: [summary key, label, icon, tone, format] */
const KPIS = {
  production: [['cut', 'Cut', 'Scissors', 'primary'], ['sewn', 'Sewn', 'Spline', 'accent'], ['finished', 'Ironed / finished', 'Sparkles', 'blue'], ['fgInward', 'Finished goods in', 'PackageCheck', 'green'], ['rejected', 'Rejected (all depts)', 'XCircle', 'red'], ['downtimeMin', 'Downtime (min)', 'AlarmClock', 'amber'], ['consistency', 'Sheets ≠ hourly rows', 'ShieldAlert', 'red']],
  wip: [['jobs', 'Jobs on department flow', 'Factory', 'primary'], ['wip', 'Pieces in WIP', 'Layers', 'amber'], ['held', 'Quality held', 'ShieldAlert', 'red'], ['issues', 'Jobs with reconciliation issues', 'AlertTriangle', 'red']],
  quality: [['inspections', 'Inspections', 'ShieldCheck', 'primary'], ['lot', 'Pieces submitted', 'Boxes', 'blue'], ['fpyPct', 'First-pass yield %', 'BadgeCheck', 'green', 1], ['rejectionPct', 'Rejection %', 'XCircle', 'red', 2], ['reworkPct', 'Rework %', 'Wrench', 'amber', 2], ['held', 'Still on hold', 'ShieldAlert', 'red'], ['openIssues', 'Open quality issues', 'AlertCircle', 'amber'], ['overdueCapa', 'Overdue CAPA', 'AlarmClock', 'red'], ['pendingInspections', 'Lots awaiting inspection', 'Hourglass', 'amber']],
  fg: [['fgAvailable', 'FG available to ship', 'PackageCheck', 'green'], ['held', 'Held by quality', 'ShieldAlert', 'red'], ['shipped', 'Shipped', 'Ship', 'primary'], ['balance', 'Order balance to ship', 'Hourglass', 'amber'], ['late', 'Late jobs', 'AlarmClock', 'red']],
  hr: [['headcount', 'Man-days', 'Users', 'primary'], ['absenteeismPct', 'Absenteeism %', 'CalendarX', 'amber', 1], ['otHours', 'Overtime hours', 'AlarmClock', 'blue', 1], ['labourActual', 'Labour – actual (payroll)', 'Banknote', 'green', 2, true], ['labourEstimated', 'Labour – estimated (no payroll yet)', 'Calculator', 'amber', 2, true], ['payrollCost', 'Payroll cost posted', 'Wallet', 'accent', 2, true]],
  expenses: [['approved', 'Approved expenses', 'Coins', 'primary', 2, true], ['pendingApproval', 'Awaiting approval', 'Hourglass', 'amber'], ['pendingAmount', 'Amount awaiting approval', 'Hourglass', 'amber', 2, true], ['unpaid', 'Unpaid', 'Wallet', 'red', 2, true], ['quality', 'Quality-related', 'ShieldCheck', 'blue', 2, true], ['shared', 'Shared with other unit', 'Split', 'accent', 2, true]],
  copq: [['actual', 'Actual quality cost', 'ShieldCheck', 'primary', 2, true], ['claims', 'Buyer claims & deductions', 'ReceiptText', 'red', 2, true], ['memo', 'In-house rework (inside labour)', 'Wrench', 'amber', 2, true], ['estimatedScrap', 'Scrap (estimated)', 'Calculator', 'amber', 2, true], ['perPc', 'Quality cost / accepted pc', 'Percent', 'blue', 4, true]],
  pnl: [['revenue', 'Net revenue (recognised)', 'BadgeDollarSign', 'primary', 2, true], ['cogs', 'Cost of goods sold', 'Coins', 'amber', 2, true], ['grossProfit', 'Gross profit', 'TrendingUp', 'green', 2, true], ['factoryOverheads', 'Unabsorbed factory cost & depreciation', 'Factory', 'amber', 2, true], ['operatingProfit', 'Operating profit', 'TrendingUp', 'accent', 2, true], ['marginPct', 'Operating margin %', 'Percent', 'blue', 2], ['netProfit', 'Net profit', 'Banknote', 'green', 2, true], ['netCash', 'Net cash flow', 'Wallet', 'blue', 2, true], ['receivables', 'Receivables', 'HandCoins', 'amber', 2, true], ['payables', 'Payables', 'Wallet', 'red', 2, true]],
};

const money = (v, d = 2) => (v === null || v === undefined ? '—' : fmtNum(v, d));

export default function FactoryCenter() {
  const { user, can } = useAuth();
  const unitName = useUnitName();
  const { tab: tabParam } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const canMoney = (m) => can('pnl', 'view') || (m === 'hr' && can('payroll', 'view')) || (m === 'expenses' && can('factoryExpense', 'view'));
  const tabs = TABS.filter((t) => !t.money || canMoney(t.money)).filter((t) => t.key !== 'overview' || can('factoryReports', 'view'));
  const tab = tabs.find((t) => t.key === tabParam)?.key || tabs[0]?.key;
  const def = tabs.find((t) => t.key === tab);
  const q = Object.fromEntries([...sp.entries()]);
  const range = { from: q.from || (tab === 'pnl' ? MONTH_START() : presetRange(29).from), to: q.to || iso(new Date()) };
  const set = (patch) => setSp(Object.fromEntries(Object.entries({ ...q, ...patch }).filter(([, v]) => v !== '' && v !== undefined && v !== null)), { replace: true });
  const scope = q.unit === 'ALL' ? 'Both units (consolidated)' : unitName(q.unit || user.unit.code);
  const [opts, setOpts] = useState(null);
  useEffect(() => { api.get('/factory/options').then((r) => setOpts(r.data)).catch(() => setOpts({})); }, []);

  return (
    <div>
      <PageHead title="Factory Control Center" icon="Factory" subtitle={`${scope} · production hour by hour, quality, labour, factory costs, finished goods and P&L – every figure traced to its source records`}>
        <UnitScope value={q.unit} onChange={(v) => set({ unit: v })} style={{ width: 'auto' }} />
      </PageHead>
      <Tabs value={tab} onChange={(t) => nav(`/factory/${t}${sp.toString() ? `?${sp}` : ''}`)} tabs={tabs.map(({ key, label }) => ({ key, label }))} />
      {def && <Filters def={def} q={q} range={range} set={set} opts={opts || {}} />}
      {tab === 'overview' && <Overview params={{ ...q, ...range }} canMoney={can('pnl', 'view')} />}
      {def?.report && <Report key={def.report} report={def.report} params={{ ...q, ...(def.filters.includes('dates') ? range : {}) }} />}
      {tab === 'job' && <JobHistory jobNo={q.jobNo} onJob={(jobNo) => set({ jobNo })} />}
      {tab === 'integrity' && <Integrity unit={q.unit} />}
    </div>
  );
}

/* ------------------------------ filters ------------------------------ */
function Filters({ def, q, range, set, opts }) {
  const f = def.filters;
  if (!f.length) return null;
  const text = (key, ph, w = 140) => <input key={key} placeholder={ph} defaultValue={q[key] || ''} style={{ width: w }} onKeyDown={(e) => e.key === 'Enter' && set({ [key]: e.target.value.trim() })} onBlur={(e) => e.target.value.trim() !== (q[key] || '') && set({ [key]: e.target.value.trim() })} aria-label={ph} />;
  const pick = (key, ph, list = []) => (
    <select key={key} value={q[key] || ''} onChange={(e) => set({ [key]: e.target.value })} style={{ width: 'auto' }} aria-label={ph}>
      <option value="">{ph}</option>{list.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  return (
    <div className="card card-pad mb mt">
      <div className="row-wrap">
        {f.includes('dates') && <>
          {PRESETS.map(([k, l, days]) => { const r = presetRange(days); return <button key={k} className={`btn btn-sm ${r.from === range.from && r.to === range.to ? 'btn-primary' : ''}`} onClick={() => set(r)}>{l}</button>; })}
          <label className="small muted">From</label><input type="date" value={range.from} onChange={(e) => e.target.value && set({ from: e.target.value })} style={{ width: 'auto' }} />
          <label className="small muted">To</label><input type="date" value={range.to} onChange={(e) => e.target.value && set({ to: e.target.value })} style={{ width: 'auto' }} />
        </>}
        {f.includes('department') && pick('department', 'All departments', opts.departments)}
        {f.includes('section') && pick('section', 'All sections', opts.sections)}
        {f.includes('stage') && pick('stage', 'All inspection stages', opts.stages)}
        {f.includes('category') && pick('category', 'All categories', opts.categories)}
        {f.includes('shift') && pick('shift', 'All shifts', opts.shifts)}
        {f.includes('line') && text('line', 'Line')}
        {f.includes('inspector') && text('inspector', 'Inspector')}
        {f.includes('defect') && text('defect', 'Defect')}
        {f.includes('job') && <>{text('jobNo', 'Main / Sub Job No', 150)}{text('buyer', 'Buyer')}{text('styleNo', 'Style', 110)}</>}
        {f.includes('bucket') && pick('bucket', 'By month', ['day', 'week', 'month'])}
        {f.includes('include') && (
          <select value={q.include || ''} onChange={(e) => set({ include: e.target.value })} style={{ width: 'auto' }} aria-label="Jobs">
            <option value="">Open jobs</option><option value="all">All jobs (incl. closed)</option>
          </select>
        )}
        <div className="grow" />
        <button className="btn btn-sm btn-ghost" onClick={() => set(Object.fromEntries(['department', 'section', 'stage', 'category', 'shift', 'line', 'inspector', 'defect', 'jobNo', 'buyer', 'styleNo', 'bucket', 'include', 'from', 'to'].map((k) => [k, ''])))}><Icon name="RotateCcw" size={14} /> Reset</button>
      </div>
    </div>
  );
}

/* ------------------------------ generic report ------------------------------ */
function useReport(path, params) {
  const { toast } = useFeedback();
  const [data, setData] = useState(null);
  const key = JSON.stringify(params);
  useEffect(() => {
    setData(null);
    if (!path) return;
    const p = Object.fromEntries(Object.entries(params).filter(([k, v]) => v && k !== 'table'));
    api.get(path, { params: p }).then((r) => setData(r.data)).catch((e) => { toast(errMsg(e), 'err'); setData({ error: true }); });
  }, [path, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

function Report({ report, params }) {
  const data = useReport(`/factory/report/${report}`, params);
  const [sp, setSp] = useSearchParams();
  if (!data) return <Loading />;
  if (data.error) return <Empty icon="AlertTriangle" title="Could not load the report" />;
  const keys = Object.keys(data.tables);
  const tKey = keys.includes(sp.get('table')) ? sp.get('table') : keys[0];
  const t = data.tables[tKey];
  const pickTable = (k) => { const n = new URLSearchParams(sp); n.set('table', k); setSp(n, { replace: true }); };
  const exportAs = (format) => download(`/factory/report/${report}`, { ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)), table: tKey, format }, `${report}-${tKey}.${format}`);
  return (
    <div>
      {data.period && <div className="muted small mb">Period {data.period}</div>}
      <div className="kpis">
        {(KPIS[report] || []).map(([k, label, icon, tone, d = 0, isMoney], i) => (
          <Kpi key={k} label={label} icon={icon} tone={tone} delay={i * 30} value={data.summary?.[k] === null || data.summary?.[k] === undefined ? '—' : Number(data.summary[k])} decimals={d} format={isMoney ? (v) => fmtCompact(v) : undefined} />
        ))}
      </div>
      {data.notes && <div className="alert alert-info mt">{data.notes.map((n) => <div key={n} className="small">{n}</div>)}</div>}
      <ReportCharts report={report} data={data} />
      <Card className="mt" title={t.title} icon="Table" pad={false} actions={<>
        <button className="btn btn-sm" onClick={() => exportAs('csv')}><Icon name="FileDown" size={14} /> CSV</button>
        <button className="btn btn-sm" onClick={() => exportAs('xlsx')}><Icon name="FileSpreadsheet" size={14} /> Excel</button>
      </>}>
        <div className="row-wrap" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          {keys.map((k) => <button key={k} className={`btn btn-sm ${k === tKey ? 'btn-primary' : 'btn-ghost'}`} onClick={() => pickTable(k)}>{data.tables[k].title.replace(/\s*\(.*\)$/, '')} <span className="muted small">{data.tables[k].rows.length}</span></button>)}
        </div>
        <DataGrid table={t} />
      </Card>
    </div>
  );
}

/** Sortable table of report rows; link columns and rows open the source record. */
export function DataGrid({ table, limit = 500 }) {
  const nav = useNavigate();
  const [sort, setSort] = useState(null);
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const { key, dir } = sort;
    return [...table.rows].sort((a, b) => { const x = a[key]; const y = b[key]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * dir; });
  }, [table, sort]);
  if (!table.rows.length) return <Empty title="No records for these filters" />;
  const open = (r) => { if (!r._link) return; if (r._link.module === 'orders') nav(`/jobs/${r.jobNo || r.subJob || r.mainJob}`); else nav(`/m/${r._link.module}/${r._link.id}`); };
  const cell = (r, c) => {
    const v = r[c.key];
    if (c.num !== undefined) return v === null || v === undefined || v === '' ? '—' : fmtNum(v, c.num);
    if (c.key === 'status' || c.key === 'capaStatus') return v ? <StatusBadge status={v} /> : '—';
    if (c.key === 'overdue' && v) return <Badge tone="red">{v}</Badge>;
    if (c.link && r._link) return <span className="link mono">{String(v ?? '')}</span>;
    return v === null || v === undefined || v === '' ? '—' : String(v);
  };
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{table.columns.map((c) => (
          <th key={c.key} className={`sortable ${c.num !== undefined ? 'num' : ''}`} onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key ? -s.dir : (c.num !== undefined ? -1 : 1) }))}>
            {c.label}{sort?.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
          </th>
        ))}</tr></thead>
        <tbody>{rows.slice(0, limit).map((r, i) => (
          <tr key={i} className={r._link ? 'click' : ''} onClick={() => open(r)}>
            {table.columns.map((c) => <td key={c.key} className={c.num !== undefined ? 'num' : ''}>{cell(r, c)}</td>)}
          </tr>
        ))}</tbody>
      </table>
      {rows.length > limit && <div className="muted small" style={{ padding: 10 }}>Showing {limit} of {rows.length} rows – export for the full list.</div>}
    </div>
  );
}

/* ------------------------------ charts (each paired with its table above) ------------------------------ */
function ReportCharts({ report, data }) {
  const t = useChartTheme();
  if (report === 'production') {
    const days = [...new Set(data.tables.daily.rows.map((r) => r.date))].sort();
    const sew = days.map((d) => { const r = data.tables.daily.rows.filter((x) => x.date === d && x.department === 'Sewing and Stitching'); return { date: d.slice(5), Output: r.reduce((a, x) => a + x.completed, 0), Target: r.reduce((a, x) => a + x.target, 0) }; });
    if (!sew.some((x) => x.Output || x.Target)) return null;
    return (
      <Card className="mt" title="Sewing – daily output vs target (pieces)" icon="BarChart3">
        <ChartBox height={240}>
          <BarChart data={sew} barGap={2}>
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={44} />
            <ChartTooltip /><ChartLegend />
            <Bar dataKey="Target" fill={t.series[1]} radius={[4, 4, 0, 0]} maxBarSize={16} />
            <Bar dataKey="Output" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={16} />
          </BarChart>
        </ChartBox>
      </Card>
    );
  }
  if (report === 'quality' && data.tables.pareto.rows.length) {
    const rows = data.tables.pareto.rows.slice(0, 10).map((r) => ({ defect: r.defectType, Defects: r.count }));
    return (
      <Card className="mt" title="Defect Pareto – top defects (count)" icon="BarChart3">
        <ChartBox height={Math.max(160, rows.length * 28)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8 }}>
            <CartesianGrid horizontal={false} stroke={t.grid} />
            <XAxis type="number" tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="defect" tickLine={false} axisLine={false} width={190} />
            <ChartTooltip />
            <Bar dataKey="Defects" fill={t.series[0]} radius={[0, 4, 4, 0]} maxBarSize={16} />
          </BarChart>
        </ChartBox>
      </Card>
    );
  }
  if (report === 'pnl' && data.tables.period.rows.length) {
    const rows = data.tables.period.rows.map((r) => ({ period: r.period, 'Net revenue': r.revenue, 'Cost of goods sold': r.cogs, 'Operating profit': r.operatingProfit }));
    return (
      <Card className="mt" title="Revenue, cost of goods sold and operating profit by period" icon="BarChart3">
        <ChartBox height={260}>
          <BarChart data={rows} barGap={2}>
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis dataKey="period" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={52} />
            <ChartTooltip format={(v) => money(v)} /><ChartLegend />
            <Bar dataKey="Net revenue" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
            <Bar dataKey="Cost of goods sold" fill={t.series[1]} radius={[4, 4, 0, 0]} maxBarSize={18} />
            <Bar dataKey="Operating profit" fill={t.series[2]} radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ChartBox>
      </Card>
    );
  }
  if (report === 'hr' && data.tables.monthly.rows.length) {
    const months = [...new Set(data.tables.monthly.rows.map((r) => r.month))].sort();
    const rows = months.map((m) => { const r = data.tables.monthly.rows.filter((x) => x.month === m); const s = (k) => r.reduce((a, x) => a + x[k], 0); return { month: m, 'Actual (payroll)': s('labourActual'), 'Estimated (attendance)': s('labourEstimated') }; });
    return (
      <Card className="mt" title="Labour cost by month – actual vs estimated" icon="BarChart3">
        <ChartBox height={220}>
          <BarChart data={rows} barGap={2}>
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={48} />
            <ChartTooltip format={(v) => money(v)} /><ChartLegend />
            <Bar dataKey="Actual (payroll)" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="Estimated (attendance)" fill={t.series[1]} radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ChartBox>
      </Card>
    );
  }
  return null;
}

/* ------------------------------ overview ------------------------------ */
function Overview({ params, canMoney }) {
  const d = useReport('/factory/dashboard', params);
  const t = useChartTheme();
  const nav = useNavigate();
  if (!d) return <Loading />;
  if (d.error) return <Empty icon="AlertTriangle" title="Could not load the dashboard" />;
  const go = (tab) => nav(`/factory/${tab}`);
  const daily = [...new Set(d.production.daily.map((r) => r.date))].sort().map((date) => {
    const r = d.production.daily.filter((x) => x.date === date);
    const of = (dep) => r.filter((x) => x.department === dep).reduce((a, x) => a + x.completed, 0);
    return { date: date.slice(5), Cut: of('Cutting'), Sewn: of('Sewing and Stitching'), 'Finished goods in': of('Finished Goods Inward') };
  });
  return (
    <div>
      <h3 className="mt">Production & flow</h3>
      <div className="kpis">
        <Kpi label="Cut" value={d.production.cut} icon="Scissors" onClick={() => go('production')} />
        <Kpi label="Sewn" value={d.production.sewn} icon="Spline" tone="accent" onClick={() => go('production')} />
        <Kpi label="Finished goods in" value={d.production.fgInward} icon="PackageCheck" tone="green" onClick={() => go('production')} />
        <Kpi label="Downtime (min)" value={d.production.downtimeMin} icon="AlarmClock" tone="amber" onClick={() => go('production')} />
        <Kpi label="FG available to ship" value={d.fg.fgAvailable} icon="Ship" tone="blue" onClick={() => go('fg')} />
        <Kpi label="Late jobs" value={d.fg.late} icon="CalendarX" tone="red" onClick={() => go('fg')} />
      </div>
      {daily.length > 0 && (
        <Card className="mt" title="Daily output – cut, sewn and finished goods in (pieces)" icon="LineChart">
          <ChartBox height={240}>
            <LineChart data={daily}>
              <CartesianGrid vertical={false} stroke={t.grid} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={44} />
              <ChartTooltip /><ChartLegend />
              {['Cut', 'Sewn', 'Finished goods in'].map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={t.series[i]} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 5 }} />)}
            </LineChart>
          </ChartBox>
        </Card>
      )}
      <h3 className="mt">Quality</h3>
      <div className="kpis">
        <Kpi label="First-pass yield %" value={d.quality.fpyPct ?? '—'} decimals={1} icon="BadgeCheck" tone="green" onClick={() => go('quality')} />
        <Kpi label="Rejection %" value={d.quality.rejectionPct ?? '—'} decimals={2} icon="XCircle" tone="red" onClick={() => go('quality')} />
        <Kpi label="On quality hold now" value={d.quality.held} icon="ShieldAlert" tone="red" onClick={() => go('quality')} />
        <Kpi label="Open issues now" value={d.quality.openIssues} icon="Wrench" tone="amber" onClick={() => go('quality')} />
        <Kpi label="Overdue CAPA" value={d.quality.overdueCapa} icon="AlarmClock" tone="red" onClick={() => go('quality')} />
      </div>
      {canMoney && d.pnl && <>
        <h3 className="mt">Labour, factory costs and profit</h3>
        <div className="kpis">
          <Kpi label="Labour – actual" value={d.hr.labourActual} format={fmtCompact} icon="Banknote" tone="green" onClick={() => go('hr')} />
          <Kpi label="Labour – estimated" value={d.hr.labourEstimated} format={fmtCompact} icon="Calculator" tone="amber" onClick={() => go('hr')} />
          <Kpi label="Factory expenses" value={d.expenses.approved} format={fmtCompact} icon="Factory" tone="primary" onClick={() => go('expenses')} />
          <Kpi label="Net revenue" value={d.pnl.revenue} format={fmtCompact} icon="BadgeDollarSign" tone="accent" onClick={() => go('pnl')} />
          <Kpi label="Operating profit" value={d.pnl.operatingProfit} format={fmtCompact} icon="TrendingUp" tone="green" sub={d.pnl.marginPct !== null ? `${fmtNum(d.pnl.marginPct, 1)}% margin` : ''} onClick={() => go('pnl')} />
          <Kpi label="Net cash flow" value={d.pnl.netCash} format={fmtCompact} icon="Wallet" tone="blue" onClick={() => go('pnl')} />
        </div>
      </>}
      {d.compare?.length > 0 && (
        <Card className="mt" title="Unit-1 vs Unit-2" icon="Building2" pad={false}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Unit</th><th className="num">Cut</th><th className="num">Sewn</th><th className="num">FG in</th><th className="num">FPY %</th><th className="num">Rejection %</th><th className="num">Held</th><th className="num">FG available</th>{canMoney && <><th className="num">Labour</th><th className="num">Factory exp.</th><th className="num">Revenue</th><th className="num">Operating profit</th></>}</tr></thead>
              <tbody>{d.compare.map((r) => (
                <tr key={r.unit}><td>{r.unit}</td><td className="num">{fmtNum(r.cut)}</td><td className="num">{fmtNum(r.sewn)}</td><td className="num">{fmtNum(r.fgInward)}</td><td className="num">{r.fpyPct ?? '—'}</td><td className="num">{r.rejectionPct ?? '—'}</td><td className="num">{fmtNum(r.held)}</td><td className="num">{fmtNum(r.fgAvailable)}</td>
                  {canMoney && <><td className="num">{money(r.labour)}</td><td className="num">{money(r.expenses)}</td><td className="num">{money(r.revenue)}</td><td className="num">{money(r.operatingProfit)}</td></>}</tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------ job history ------------------------------ */
function JobHistory({ jobNo, onJob }) {
  const [input, setInput] = useState(jobNo || '');
  const d = useReport(jobNo ? `/factory/job/${encodeURIComponent(jobNo)}` : null, {});
  return (
    <div className="mt">
      <div className="card card-pad mb">
        <div className="row-wrap">
          <input placeholder="Main or Sub Job No, e.g. U1-1000 or U1-1000-S02" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onJob(input.trim())} style={{ width: 320 }} />
          <button className="btn btn-primary btn-sm" onClick={() => onJob(input.trim())}><Icon name="Search" size={14} /> Show history</button>
          {jobNo && <Link className="btn btn-sm" to={`/jobs/${jobNo}`}><Icon name="RadioTower" size={14} /> Job 360</Link>}
        </div>
      </div>
      {!jobNo ? <Empty icon="Search" title="Enter a Main Job or Sub Job number" /> : !d ? <Loading /> : d.error ? <Empty icon="AlertTriangle" title="Job not found" /> : <>
        <div className="muted small mb">{d.job.unit} · {d.job.jobNo} · {d.job.buyerName} · {d.job.styleNo}{d.job.subJobs.length ? ` · sub jobs ${d.job.subJobs.join(', ')}` : ''}</div>
        <Card title={d.tables.flow.title} icon="Layers" pad={false}><DataGrid table={d.tables.flow} /></Card>
        <Card className="mt" title={d.tables.timeline.title} icon="History" pad={false}><DataGrid table={d.tables.timeline} /></Card>
      </>}
    </div>
  );
}

/* ------------------------------ integrity ------------------------------ */
function Integrity({ unit }) {
  const [tick, setTick] = useState(0);
  const d = useReport('/factory/integrity', { unit, tick: String(tick) });
  const nav = useNavigate();
  const [open, setOpen] = useState(null);
  if (!d) return <Loading />;
  if (d.error) return <Empty icon="AlertTriangle" title="Could not run the checks" />;
  return (
    <div className="mt">
      <div className="kpis mb">
        <Kpi label="Checks passed" value={d.passed} icon="CheckCircle2" tone="green" />
        <Kpi label="Checks failed" value={d.failed} icon="XCircle" tone={d.failed ? 'red' : 'green'} />
        <Kpi label="Scope" value={d.units.join(' + ')} icon="Building2" tone="blue" />
      </div>
      <Card title={`Validation & reconciliation – checked ${new Date(d.checkedAt).toLocaleString()}`} icon="ShieldCheck" actions={<button className="btn btn-sm" onClick={() => setTick((x) => x + 1)}><Icon name="RefreshCw" size={14} /> Re-run</button>} pad={false}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Result</th><th>Area</th><th>Check</th><th>Rule</th><th className="num">Exceptions</th></tr></thead>
            <tbody>{d.checks.map((c, i) => (
              <Fragment key={c.title}>
                <tr className={c.count ? 'click' : ''} onClick={() => c.count && setOpen(open === i ? null : i)}>
                  <td><Badge tone={c.status === 'PASS' ? 'green' : 'red'}>{c.status}</Badge></td><td>{c.area}</td><td>{c.title}</td><td className="muted small">{c.rule}</td><td className="num">{c.count}</td>
                </tr>
                {open === i && c.items.map((it, j) => (
                  <tr key={`${c.title}-${j}`} className={it._link ? 'click' : ''} onClick={() => it._link && (it._link.module === 'orders' ? nav(`/jobs/${it.jobNo}`) : nav(`/m/${it._link.module}/${it._link.id}`))}>
                    <td /><td colSpan={4} className="small">{[it.jobNo, it.ref, it.unit, it.message].filter(Boolean).join(' · ')}</td>
                  </tr>
                ))}
              </Fragment>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
