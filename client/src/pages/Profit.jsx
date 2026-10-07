/** Profit analysis across jobs: expected vs actual, variance, margin. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { api, errMsg, download } from '../api.js';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Card, Kpi, Loading, Icon, StatusBadge, Empty } from '../components/ui.jsx';
import { ChartBox, ChartTooltip, ChartLegend, useChartTheme } from '../components/Charts.jsx';
import { fmtNum, fmtCompact } from '../utils/format.js';

export default function Profit() {
  const { toast } = useFeedback();
  const nav = useNavigate();
  const t = useChartTheme();
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/reports/profit').then((r) => setRows(r.data.rows)).catch((e) => { toast(errMsg(e), 'err'); setRows([]); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <Loading />;
  // actual figures are only meaningful once a job has revenue (invoiced / shipped)
  const earning = rows.filter((r) => r.revenue > 0);
  const tot = (k, list = rows) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const revenue = tot('revenue', earning); const actual = tot('actualProfit', earning);
  const chart = rows.filter((r) => r.revenue > 0 || r.expectedProfit > 0).slice(0, 12).map((r) => ({ job: r.jobNo.replace(/^[A-Z]+-\d{4}-/, ''), Expected: Math.round(r.expectedProfit), Actual: r.revenue > 0 ? Math.round(r.actualProfit) : null }));

  return (
    <div>
      <PageHead title="Profit Analysis" icon="TrendingUp" subtitle="Order value − fabric − trims − production − labour − overhead − freight − other = actual profit">
        <button className="btn" onClick={() => download('/reports/profit', { format: 'xlsx' })}><Icon name="FileSpreadsheet" size={15} /> Excel</button>
      </PageHead>
      <div className="kpis">
        <Kpi label="Expected Revenue" value={tot('expectedRevenue')} format={(v) => `$${fmtCompact(v)}`} icon="Banknote" tone="primary" />
        <Kpi label="Revenue" value={revenue} format={(v) => `$${fmtCompact(v)}`} icon="BadgeDollarSign" tone="accent" />
        <Kpi label="Expenses (invoiced jobs)" value={tot('totalExpenses', earning)} format={(v) => `$${fmtCompact(v)}`} icon="Coins" tone="amber" />
        <Kpi label="Expected Profit" value={tot('expectedProfit')} format={(v) => `$${fmtCompact(v)}`} icon="Target" tone="blue" />
        <Kpi label="Actual Profit" value={actual} format={(v) => `$${fmtCompact(v)}`} icon="TrendingUp" tone="green" sub={`${revenue ? fmtNum((actual / revenue) * 100, 1) : 0}% margin`} />
      </div>
      {chart.length > 0 && (
        <Card className="mt" title="Expected vs actual profit by job" icon="BarChart3">
          <ChartBox height={280}>
            <BarChart data={chart} barGap={2}>
              <CartesianGrid vertical={false} stroke={t.grid} />
              <XAxis dataKey="job" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={48} />
              <ChartTooltip format={(v) => `$${fmtNum(v)}`} /><ChartLegend />
              <Bar dataKey="Expected" fill={t.series[0]} radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Bar dataKey="Actual" fill={t.series[2]} radius={[4, 4, 0, 0]} maxBarSize={20} />
            </BarChart>
          </ChartBox>
        </Card>
      )}
      <Card className="mt" title="Job profitability" icon="Table" pad={false}>
        {!rows.length ? <Empty title="No jobs" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Job</th><th>Buyer / Style</th><th className="num">Shipped</th><th className="num">Revenue</th><th className="num">Expenses</th><th className="num">Expected</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">Profit %</th><th>Status</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r._id} className="click" onClick={() => nav(`/jobs/${r.jobNo}`)}>
                  <td className="mono link">{r.jobNo}</td><td>{r.buyerName}<div className="muted small">{r.styleNo}</div></td>
                  <td className="num">{fmtNum(r.shippedQty)}</td><td className="num">{fmtNum(r.revenue, 2)}</td><td className="num">{fmtNum(r.totalExpenses, 2)}</td>
                  <td className="num">{fmtNum(r.expectedProfit, 2)}</td>
                  {r.revenue > 0 ? <>
                    <td className="num" style={{ color: r.actualProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 650 }}>{fmtNum(r.actualProfit, 2)}</td>
                    <td className="num">{fmtNum(r.profitVariance, 2)}</td><td className="num">{r.profitPct}%</td>
                  </> : <td className="muted small" colSpan={3}>Not invoiced yet – costs to date {fmtNum(r.totalExpenses, 0)}</td>}<td><StatusBadge status={r.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
