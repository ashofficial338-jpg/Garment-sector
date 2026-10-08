import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line } from 'recharts';
import { api, errMsg } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { UnitScope, useUnitName } from '../components/UnitScope.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { Kpi, Card, Icon, Loading, StatusBadge, Progress, Badge, Empty } from '../components/ui.jsx';
import { ChartBox, ChartTooltip, ChartLegend, useChartTheme } from '../components/Charts.jsx';
import { fmtCompact, fmtCurrency, fmtDate, fmtNum, STAGE_LABEL } from '../utils/format.js';

/** Which KPI sections each department dashboard shows */
export const DASHBOARDS = {
  admin: { title: 'Company Overview', sections: ['merchandising', 'preproduction', 'fabric', 'production', 'quality', 'shipment', 'accounts', 'finance'] },
  merchandising: { title: 'Merchandising', sections: ['merchandising', 'preproduction', 'fabric', 'production', 'shipment'] },
  preproduction: { title: 'CAD / Pattern', sections: ['preproduction', 'fabric', 'production'] },
  costing: { title: 'Costing', sections: ['merchandising', 'finance'] },
  fabric: { title: 'Fabric Department', sections: ['fabric'] },
  production: { title: 'Production', sections: ['production', 'quality'] },
  quality: { title: 'Quality', sections: ['quality', 'production'] },
  shipment: { title: 'Shipment & Documentation', sections: ['shipment', 'quality'] },
  accounts: { title: 'Accounts & Finance', sections: ['accounts', 'finance'] },
  hr: { title: 'HR', sections: ['hr'] },
};

const money = (v) => `$${fmtCompact(v)}`;

/** KPI sections without their own link drill into the matching analytics view (analytics permission only). */
const SECTION_DRILL = { merchandising: 'variance', fabric: 'operations', production: 'operations', quality: 'variance', shipment: 'operations', accounts: 'finance', finance: 'finance' };

/**
 * Management KPIs (Revenue → COGS → EBITDA, ITR, holding period, ROI, cost variance) – calculated on the
 * server for the selected unit; Admin, or users granted the analytics permission. Each card opens its analysis.
 */
function ManagementKpis({ scope, drill }) {
  const [m, setM] = useState(null);
  useEffect(() => { setM(null); api.get('/analytics/summary', { params: { unit: scope || undefined } }).then((r) => setM(r.data)).catch(() => setM(false)); }, [scope]);
  if (m === false) return null;
  if (!m) return <div className="mt"><div className="form-section-title"><Icon name="ChartNoAxesCombined" size={14} /> Management (last 12 months)</div><Loading /></div>;
  const cur = (v) => fmtCurrency(v, m.currency, true);
  const days = (v) => (v === null ? 'n/a' : `${fmtNum(v)} days`);
  const f = m.finance; const i = m.inventory; const r = m.roi;
  const items = [
    ['Revenue', f.revenue, cur, 'Banknote', 'primary', 'finance', 'issued invoices'],
    ['COGS', f.cogs, cur, 'Factory', 'amber', 'finance', 'cost of goods sold'],
    ['EBITDA', f.ebitda, cur, 'Landmark', 'green', 'finance', `${f.ebitdaMarginPct}% of revenue`],
    ['Net Profit', f.netProfit, cur, 'BadgeDollarSign', 'blue', 'finance', `${f.netMarginPct}% net margin`],
    ['Inventory Turnover', i.itr === null ? 'n/a' : `${fmtNum(i.itr, 2)}x`, null, 'RefreshCw', 'accent', 'inventory', 'COGS ÷ avg inventory'],
    ['Inventory Holding', days(i.holdingDays), null, 'Hourglass', 'violet', 'inventory', `fabric ${days(i.holdingDaysByType.fabric)} · FG ${days(i.holdingDaysByType.finishedGoods)}`],
    ['Style ROI', r.roiPct === null ? 'n/a' : `${fmtNum(r.roiPct, 1)}%`, null, 'Percent', 'green', 'roi&by=style', r.topStyle ? `best ${r.topStyle.key} ${fmtNum(r.topStyle.roiPct, 1)}%` : 'no invoiced jobs'],
    ['Product ROI', r.topProduct ? `${fmtNum(r.topProduct.roiPct, 1)}%` : 'n/a', null, 'Shirt', 'primary', 'roi&by=product', r.topProduct ? `best: ${r.topProduct.key}` : 'no invoiced jobs'],
    ['Cost Variance', m.variance.variance, cur, 'Scale', m.variance.variance > 0 ? 'red' : 'green', 'variance', 'actual − estimated'],
    ['Rejection Loss', m.variance.qualityLoss, cur, 'XCircle', 'red', 'variance', 'quality loss'],
  ];
  return (
    <div className="mt">
      <div className="form-section-title"><Icon name="ChartNoAxesCombined" size={14} /> Management · {m.period}</div>
      <div className="kpis">
        {items.map(([label, value, fmt, ic, tone, tab, sub], n) => (
          <Kpi key={label} label={label} icon={ic} tone={tone} delay={n * 30} value={fmt ? Number(value) || 0 : value} format={fmt || undefined} sub={sub} onClick={drill(tab)} />
        ))}
      </div>
    </div>
  );
}

function KpiSection({ name, k, drill }) {
  const nav = useNavigate();
  const S = {
    merchandising: ['Merchandising', 'ClipboardCheck', [
      ['Order Conversion', k.merchandising.orderConversionPct, '%', 'Target', 'primary', 1],
      ['On-time Approval', k.merchandising.onTimeApprovalPct, '%', 'BadgeCheck', 'green', 1],
      ['T&A Delayed Activities', k.merchandising.tnaDelayedActivities, '', 'CalendarX', 'red', 0, `avg ${k.merchandising.avgTnaDelayDays} days late`, '/reports?r=tna'],
    ]],
    preproduction: ['Pre-Production', 'DraftingCompass', [
      ['Spec Approved', k.preproduction.specApprovedPct, '%', 'FileCog', 'primary', 1, 'of active jobs', '/m/techSpec'],
      ['BOM Approved', k.preproduction.bomApprovedPct, '%', 'ListTree', 'accent', 1, k.preproduction.unbookedBomLines ? `${k.preproduction.unbookedBomLines} lines not booked` : 'all lines booked', '/reports?r=bom'],
      ['Patterns Pending', k.preproduction.patternsPending, '', 'DraftingCompass', 'amber', 0, 'not yet graded', '/m/pattern'],
      ['Markers Pending', k.preproduction.markersPending, '', 'Ruler', 'blue', 0, '', '/m/marker'],
      ['Marker vs BOM', k.preproduction.markerVariancePct, '%', 'Scale', k.preproduction.markerVariancePct > 3 ? 'red' : 'green', 2, 'avg consumption variance', '/reports?r=marker'],
    ]],
    fabric: ['Fabric', 'Layers', [
      ['Fabric Booked', k.fabric.bookingPct, '%', 'BookCheck', 'primary', 1],
      ['Fabric In-house', k.fabric.inhousePct, '%', 'Warehouse', 'accent', 1],
      ['Fabric Shortage', k.fabric.shortageQty, '', 'AlertTriangle', 'red', 0, `${k.fabric.shortageBookings} bookings`, '/m/fabricBooking'],
      ['Cutting Wastage', k.fabric.wastagePct, '%', 'Scissors', 'amber', 1],
      ['Fabric Ready to Close', k.fabric.readyToClose, '', 'Lock', 'violet', 0, '', '/m/fabricBooking'],
    ]],
    production: ['Production', 'Factory', [
      ['Daily Target', k.production.dailyTarget, '', 'Target', 'primary', 0, k.production.lastDay ? fmtDate(k.production.lastDay) : 'no entries'],
      ['Actual Production', k.production.actualProduction, '', 'Spline', 'green', 0, k.production.lastDay ? fmtDate(k.production.lastDay) : ''],
      ['Efficiency', k.production.dayEfficiencyPct, '%', 'Gauge', 'accent', 1, `overall ${k.production.efficiencyPct}%`],
      ['Line Utilisation', k.production.lineUtilizationPct, '%', 'Rows3', 'blue', 1],
      ['WIP (cut − sewn)', k.production.wip, '', 'Boxes', 'amber', 0],
    ]],
    quality: ['Quality', 'ShieldCheck', [
      ['DHU', k.quality.dhu, '%', 'Bug', 'amber', 2],
      ['AQL Pass Rate', k.quality.aqlPassPct, '%', 'ShieldCheck', 'green', 1, `${k.quality.inspections} inspections`],
      ['Rejection', k.quality.rejectionPct, '%', 'XCircle', 'red', 2],
      ['Alteration', k.quality.alterationPct, '%', 'Wrench', 'blue', 2],
    ]],
    shipment: ['Shipment', 'Ship', [
      ['On-time Shipment', k.shipment.onTimeShipmentPct, '%', 'Ship', 'green', 1],
      ['Pending Shipments', k.shipment.pendingShipments, '', 'Hourglass', 'amber', 0, '', '/m/shipment'],
      ['Delayed Shipments', k.shipment.delayedShipments, '', 'AlarmClock', 'red', 0],
      ['Shipped Qty', k.shipment.shippedQty, '', 'PackageCheck', 'primary', 0],
    ]],
    accounts: ['Accounts', 'ReceiptText', [
      ['Receivable', k.accounts.receivable, '$', 'ReceiptText', 'primary', 0],
      ['Outstanding', k.accounts.outstanding, '$', 'Wallet', 'amber', 0, '', '/reports?r=outstanding'],
      ['Collection', k.accounts.collectionPct, '%', 'HandCoins', 'green', 1],
      ['Overdue', k.accounts.overdueAmount, '$', 'AlarmClock', 'red', 0, `${k.accounts.overdueInvoices} invoices`],
    ]],
    finance: ['Finance', 'TrendingUp', [
      ['Revenue', k.finance.revenue, '$', 'Banknote', 'primary', 0],
      ['Cost', k.finance.cost, '$', 'Coins', 'amber', 0],
      ['Expected Profit', k.finance.expectedProfit, '$', 'Target', 'blue', 0],
      ['Actual Profit', k.finance.actualProfit, '$', 'TrendingUp', 'green', 0, `${k.finance.profitPct}% margin`, '/profit'],
    ]],
    hr: ['HR', 'IdCard', [
      ['Active Employees', k.hr.employees, '', 'Users', 'primary', 0, '', '/m/employee'],
      ['Operators', k.hr.operators, '', 'Spline', 'accent', 0],
      ['On Leave', k.hr.onLeave, '', 'Plane', 'amber', 0],
      ['Avg Attendance', k.hr.avgAttendancePct, '%', 'CalendarCheck', 'green', 1],
      ['System Users', k.hr.users, '', 'UserCog', 'blue', 0],
    ]],
  };
  const [title, icon, items] = S[name];
  return (
    <div className="mt">
      <div className="form-section-title"><Icon name={icon} size={14} /> {title}</div>
      <div className="kpis">
        {items.map(([label, value, unit, ic, tone, dec, sub, link], i) => (
          <Kpi key={label} label={label} icon={ic} tone={tone} delay={i * 40} value={Number(value) || 0}
            format={(v) => (unit === '$' ? money(v) : `${fmtNum(v, dec)}${unit === '%' ? '%' : ''}`)}
            sub={sub} onClick={link ? () => nav(link) : drill?.(SECTION_DRILL[name])} />
        ))}
      </div>
    </div>
  );
}

const PIPE_COLORS = ['#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#0e7490', '#0f766e', '#15803d', '#334155'];

export function JobMiniTable({ rows, empty }) {
  const nav = useNavigate();
  if (!rows?.length) return <Empty icon="CheckCircle2" title={empty} />;
  return (
    <table className="tbl tbl-mini">
      <thead><tr><th>Job</th><th>Buyer / Style</th><th>Ship</th><th>Stage</th></tr></thead>
      <tbody>
        {rows.map((j) => (
          <tr key={j._id} className="click" onClick={() => nav(`/jobs/${j.jobNo}`)}>
            <td className="mono link">{j.jobNo}</td>
            <td><div>{j.buyerName}</div><div className="muted small">{j.styleNo} · {fmtNum(j.orderQty)} pcs</div></td>
            <td className="nowrap">{fmtDate(j.shipmentDate)}</td>
            <td style={{ minWidth: 110 }}>
              <div className="small" style={{ fontWeight: 600 }}>{STAGE_LABEL[j.currentStage]}{Object.values(j.stages || {}).includes('delayed') && <Badge tone="red" dot={false}>late</Badge>}</div>
              <Progress value={j.progressPct} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Dashboard({ focus }) {
  const { user, can } = useAuth();
  const unitName = useUnitName();
  const [scope, setScope] = useState('');
  const { toast } = useFeedback();
  const nav = useNavigate();
  const t = useChartTheme();
  const [d, setD] = useState(null);
  const cfg = DASHBOARDS[focus || 'admin'];

  useEffect(() => { setD(null); api.get('/dashboard', { params: { unit: scope || undefined } }).then((r) => setD(r.data)).catch((e) => toast(errMsg(e), 'err')); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Loading />;
  const s = d.summary;
  // Dashboard KPI → analytics page → source transactions (Admin, or the explicit analytics permission)
  const deep = can('analytics', 'view');
  const drill = (tab) => (deep && tab ? () => nav(`/analytics?tab=${tab}${scope ? `&unit=${scope}` : ''}`) : undefined);
  const Analyse = ({ tab }) => (deep ? <button className="btn btn-sm btn-ghost" onClick={drill(tab)}><Icon name="ChartNoAxesCombined" size={14} /> Analyse</button> : null);
  const hour = new Date().getHours();

  return (
    <div>
      <div className="hero rise">
        <svg className="hero-art" width="260" height="140" viewBox="0 0 260 140" aria-hidden="true">
          <path d="M60 20 40 32 20 56l18 18 12-6v62h70V68l12 6 18-18-20-24-20-12c-3 9-12 15-24 15S63 29 60 20Z" fill="none" stroke="#fff" strokeWidth="3" />
          <path d="M150 120h100M170 120V70l20-20 20 20v50" stroke="#fff" strokeWidth="3" fill="none" />
          <circle cx="200" cy="40" r="10" stroke="#fff" strokeWidth="3" fill="none" />
        </svg>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {user.name.split(' ')[0]}</h1>
            <p>{scope === 'ALL' ? 'Both units – consolidated' : (unitName(scope) || user.unit.name).toUpperCase()} · {focus ? `${cfg.title} dashboard` : 'Order to shipment overview'} · {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
          </div>
          <div className="row-wrap">
            <UnitScope value={scope} onChange={setScope} style={{ height: 36, width: 'auto' }} />
            <button className="btn" onClick={() => nav('/control-tower')}><Icon name="RadioTower" size={15} /> Track a Job</button>
            <button className="btn btn-primary" style={{ background: '#fff', color: '#312e81', borderColor: '#fff' }} onClick={() => nav('/m/orders')}><Icon name="ClipboardCheck" size={15} /> Orders</button>
          </div>
        </div>
      </div>

      {(!focus || focus === 'admin' || focus === 'merchandising') && (
        <div className="kpis mt">
          <Kpi label="Active Jobs" value={s.activeJobs} icon="Briefcase" tone="primary" onClick={() => nav('/m/orders')} sub={`${s.closedJobs} closed`} />
          <Kpi label="Orders This Month" value={s.ordersThisMonth} icon="CalendarPlus" tone="accent" delay={30} onClick={() => nav('/m/orders')} />
          <Kpi label="Pending Enquiries" value={s.pendingEnquiries} icon="MessageSquareText" tone="blue" delay={60} onClick={() => nav('/m/enquiry?status=Pending')} />
          <Kpi label="Pending Costing" value={s.pendingCosting} icon="Calculator" tone="violet" delay={90} onClick={() => nav('/m/costing')} />
          <Kpi label="Pending Approvals" value={s.pendingApprovals} icon="Stamp" tone="amber" delay={120} />
          <Kpi label="Fabric Pending" value={s.fabricPending} icon="Layers" tone="amber" delay={150} onClick={() => nav('/m/fabricBooking')} />
          <Kpi label="Production Running" value={s.productionRunning} icon="Factory" tone="green" delay={180} onClick={drill('operations')} />
          <Kpi label="Delayed Jobs" value={s.delayedJobs} icon="AlarmClock" tone="red" delay={210} onClick={drill('operations')} />
          <Kpi label="Shipment Due (14d)" value={s.shipmentDue} icon="Ship" tone="blue" delay={240} onClick={() => nav('/m/shipment')} />
          <Kpi label="Payment Pending" value={s.paymentPending} icon="Wallet" tone="amber" delay={270} onClick={() => nav('/m/invoice')} />
          <Kpi label="Expected Revenue" value={s.expectedRevenue} format={money} icon="Banknote" tone="primary" delay={300} onClick={drill('variance')} />
          <Kpi label="Actual Revenue" value={s.actualRevenue} format={money} icon="BadgeDollarSign" tone="green" delay={330} onClick={drill('finance')} />
          <Kpi label="Expected Profit" value={s.expectedProfit} format={money} icon="Target" tone="blue" delay={360} onClick={drill('variance')} />
          <Kpi label="Actual Profit" value={s.actualProfit} format={money} icon="TrendingUp" tone="green" delay={390} onClick={() => nav('/profit')} />
        </div>
      )}

      {(!focus || focus === 'admin' || focus === 'merchandising') && (
        <Card className="mt" title="Order Pipeline" icon="Workflow" actions={s.readyToClose > 0 && <Badge tone="violet">{s.readyToClose} job(s) ready to close</Badge>}>
          <div className="funnel">
            {d.pipeline.map((p, i) => (
              <div key={p.stage} className="funnel-step rise" style={{ background: PIPE_COLORS[i], animationDelay: `${i * 50}ms` }}>
                <b>{p.count}</b><span>{p.stage}</span>
                {i < d.pipeline.length - 1 && <Icon name="ChevronRight" size={16} style={{ position: 'absolute', right: 4, top: '42%', opacity: 0.5 }} />}
              </div>
            ))}
          </div>
        </Card>
      )}

      {deep && <ManagementKpis scope={scope} drill={drill} />}
      {cfg.sections.map((sec) => <KpiSection key={sec} name={sec} k={d.kpis} drill={drill} />)}

      <div className="grid g2 mt">
        {cfg.sections.some((x) => ['production', 'quality'].includes(x)) && (
          <Card title="Production – target vs actual (last 14 days)" icon="BarChart3" actions={<Analyse tab="operations" />}>
            <ChartBox>
              <BarChart data={d.charts.production} barGap={2}>
                <CartesianGrid vertical={false} stroke={t.grid} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={44} />
                <ChartTooltip /><ChartLegend />
                <Bar dataKey="target" name="Target" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar dataKey="actual" name="Actual" fill={t.series[2]} radius={[4, 4, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ChartBox>
          </Card>
        )}
        {cfg.sections.some((x) => ['production', 'quality'].includes(x)) && (
          <Card title="Sewing efficiency % (last 14 days)" icon="Gauge" actions={<Analyse tab="operations" />}>
            <ChartBox>
              <LineChart data={d.charts.production}>
                <CartesianGrid vertical={false} stroke={t.grid} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} unit="%" width={44} />
                <ChartTooltip format={(v) => `${v}%`} />
                <Line type="monotone" dataKey="efficiency" name="Efficiency" stroke={t.series[0]} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: t.surface }} activeDot={{ r: 6 }} />
              </LineChart>
            </ChartBox>
          </Card>
        )}
        {cfg.sections.some((x) => ['finance', 'accounts', 'merchandising'].includes(x)) && (
          <Card title="Order value, invoiced & collected (12 months, USD)" icon="LineChart" className={cfg.sections.includes('production') ? '' : 'span2'} actions={<Analyse tab="finance" />}>
            <ChartBox>
              <BarChart data={d.charts.monthly} barGap={2}>
                <CartesianGrid vertical={false} stroke={t.grid} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tickFormatter={(m) => m.slice(2)} />
                <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={48} />
                <ChartTooltip format={(v) => `$${fmtNum(v)}`} /><ChartLegend />
                <Bar dataKey="orders" name="Order value" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={16} />
                <Bar dataKey="invoiced" name="Invoiced" fill={t.series[1]} radius={[4, 4, 0, 0]} maxBarSize={16} />
                <Bar dataKey="collected" name="Collected" fill={t.series[2]} radius={[4, 4, 0, 0]} maxBarSize={16} />
              </BarChart>
            </ChartBox>
          </Card>
        )}
        {cfg.sections.some((x) => ['merchandising', 'finance'].includes(x)) && (
          <Card title="Top buyers by order value" icon="Building2" actions={<Analyse tab="roi&by=buyer" />}>
            <ChartBox>
              <BarChart data={d.charts.buyers} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid horizontal={false} stroke={t.grid} />
                <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={fmtCompact} />
                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={120} />
                <ChartTooltip format={(v) => `$${fmtNum(v)}`} />
                <Bar dataKey="value" name="Order value" fill={t.series[0]} radius={[0, 4, 4, 0]} maxBarSize={18} />
              </BarChart>
            </ChartBox>
          </Card>
        )}
        {cfg.sections.includes('production') && d.charts.lineEff.length > 0 && (
          <Card title="Line-wise efficiency %" icon="Rows3" actions={<Analyse tab="operations" />}>
            <ChartBox>
              <BarChart data={d.charts.lineEff}>
                <CartesianGrid vertical={false} stroke={t.grid} />
                <XAxis dataKey="line" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} unit="%" width={44} />
                <ChartTooltip format={(v) => `${v}%`} />
                <Bar dataKey="efficiency" name="Efficiency" fill={t.series[2]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ChartBox>
          </Card>
        )}
        {(!focus || ['admin', 'merchandising'].includes(focus)) && (
          <Card title="Active jobs by current stage" icon="Workflow" actions={<Analyse tab="operations" />}>
            <ChartBox>
              <BarChart data={d.charts.stageDist.map((x) => ({ ...x, label: STAGE_LABEL[x.stage] || x.stage }))}>
                <CartesianGrid vertical={false} stroke={t.grid} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={52} />
                <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={30} />
                <ChartTooltip />
                <Bar dataKey="count" name="Jobs" fill={t.series[6]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ChartBox>
          </Card>
        )}
        {cfg.sections.includes('hr') && (
          <Card title="Employees by department" icon="Users">
            <ChartBox>
              <BarChart data={d.kpis.hr.byDepartment} layout="vertical">
                <CartesianGrid horizontal={false} stroke={t.grid} />
                <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={150} />
                <ChartTooltip />
                <Bar dataKey="value" name="Employees" fill={t.series[0]} radius={[0, 4, 4, 0]} maxBarSize={18} />
              </BarChart>
            </ChartBox>
          </Card>
        )}
      </div>

      <div className="grid g2 mt">
        {cfg.sections.some((x) => ['merchandising', 'production', 'shipment'].includes(x)) && (
          <Card title="Delayed jobs" icon="AlarmClock" pad={false}><JobMiniTable rows={d.lists.delayedJobs} empty="No delayed jobs" /></Card>
        )}
        {cfg.sections.some((x) => ['merchandising', 'shipment'].includes(x)) && (
          <Card title="Upcoming shipments" icon="Ship" pad={false}><JobMiniTable rows={d.lists.upcomingShipments} empty="No upcoming shipments" /></Card>
        )}
        {cfg.sections.includes('fabric') && (
          <Card title="Fabric shortages" icon="AlertTriangle" pad={false}>
            {d.lists.fabricShortages.length ? (
              <table className="tbl tbl-mini"><thead><tr><th>Booking</th><th>Fabric</th><th className="num">Required</th><th className="num">Received</th><th className="num">Shortage</th></tr></thead>
                <tbody>{d.lists.fabricShortages.map((f) => <tr key={f._id} className="click" onClick={() => nav(`/m/fabricBooking/${f._id}`)}><td><div className="mono link">{f.refNo}</div><div className="muted small">{f.jobNo}</div></td><td>{f.fabricType}</td><td className="num">{fmtNum(f.requiredQty, 1)}</td><td className="num">{fmtNum(f.receivedQty, 1)}</td><td className="num"><Badge tone="red">{fmtNum(f.shortageQty, 1)} {f.unit}</Badge></td></tr>)}</tbody></table>
            ) : <Empty icon="CheckCircle2" title="No fabric shortages" />}
          </Card>
        )}
        {cfg.sections.includes('accounts') && (
          <Card title="Overdue invoices" icon="AlarmClock" pad={false}>
            {d.lists.overdueInvoices.length ? (
              <table className="tbl tbl-mini"><thead><tr><th>Invoice</th><th>Buyer</th><th>Due</th><th className="num">Outstanding</th></tr></thead>
                <tbody>{d.lists.overdueInvoices.map((i) => <tr key={i._id} className="click" onClick={() => nav(`/m/invoice/${i._id}`)}><td><div className="mono link">{i.invoiceNo}</div><div className="muted small">{i.jobNo}</div></td><td>{i.buyerName}</td><td>{fmtDate(i.dueDate)}</td><td className="num">{i.currency} {fmtNum(i.outstanding, 2)}</td></tr>)}</tbody></table>
            ) : <Empty icon="CheckCircle2" title="No overdue invoices" />}
          </Card>
        )}
        {(!focus || focus === 'admin') && (
          <Card title="Jobs ready for closure" icon="Lock" pad={false}><JobMiniTable rows={d.lists.readyToClose} empty="No jobs waiting for closure" /></Card>
        )}
        {(!focus || focus === 'admin') && (
          <Card title="Recently confirmed orders" icon="ClipboardCheck" pad={false} actions={<Link to="/m/orders" className="small">All orders</Link>}>
            {d.lists.recentJobs.length ? <JobMiniTable rows={d.lists.recentJobs} /> : <Empty title="No orders yet"><Link to="/m/quotation">Confirm an order from an approved quotation</Link></Empty>}
          </Card>
        )}
      </div>
      {d.kpis.merchandising.orderStatus.length > 0 && (!focus || focus === 'admin') && (
        <div className="row-wrap mt">{d.kpis.merchandising.orderStatus.map((o) => <span key={o.name} className="chip"><StatusBadge status={o.name} /> {o.value}</span>)}</div>
      )}
    </div>
  );
}
