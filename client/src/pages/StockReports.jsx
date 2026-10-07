/** Stock Reports – yarn, knitting, grey, processing, in-process, finished fabric, trims. */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, errMsg, download } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Icon, Card, Tabs, Field, Empty, Spinner, Kpi } from '../components/ui.jsx';
import { PROCESS_TYPES } from '@shared/modules/stock.js';
import { reportPdf } from '../utils/pdf.js';
import { fmtNum } from '../utils/format.js';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'yarn', label: 'Yarn Stock' },
  { key: 'knitting', label: 'Knitting' },
  { key: 'grey', label: 'Grey Fabric' },
  { key: 'processing', label: 'Processing' },
  { key: 'inprocess', label: 'In-process' },
  { key: 'finished', label: 'Finished Fabric' },
  { key: 'trims', label: 'Trims' },
];
const CHAIN = [
  { key: 'yarn', label: 'Yarn', icon: 'Package', total: 'balanceKg', unit: 'kg', module: 'yarnReceipt' },
  { key: 'grey', label: 'Grey Fabric', icon: 'Waypoints', total: 'balanceKg', unit: 'kg', module: 'knitting' },
  { key: 'inprocess', label: 'In-process', icon: 'Droplets', total: 'balanceKg', unit: 'kg', module: 'fabricProcess' },
  { key: 'finished', label: 'Finished Fabric', icon: 'Layers', total: 'balanceKg', unit: 'kg', module: 'fabricBooking' },
  { key: 'trims', label: 'Trims', icon: 'Tag', total: 'stockValue', unit: 'value', module: 'trimBooking' },
];
const isNum = (v) => typeof v === 'number';
const MONEY = ['amount', 'stockValue', 'value'];

export default function StockReports() {
  const { can } = useAuth();
  const { toast } = useFeedback();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('t') || 'overview';
  const [f, setF] = useState({ from: '', to: '', job: '', supplier: '', process: '' });
  const [data, setData] = useState(null);
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState(false);
  const params = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f]);

  const run = async () => {
    setBusy(true);
    try {
      if (tab === 'overview') {
        const res = await Promise.all(CHAIN.map((c) => api.get(`/stock/${c.key}`, { params: { job: params.job } })));
        const [kn, pr] = await Promise.all([api.get('/stock/knitting', { params: { job: params.job } }), api.get('/stock/processing', { params: { job: params.job } })]);
        setOverview({ chain: Object.fromEntries(CHAIN.map((c, i) => [c.key, res[i].data])), knitting: kn.data, processing: pr.data });
      } else setData((await api.get(`/stock/${tab}`, { params })).data);
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  useEffect(() => { setData(null); run(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportAs = (format) => download(`/stock/${tab}`, { ...params, format }).catch((e) => toast(errMsg(e), 'err'));
  const filterText = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join(' · ');

  return (
    <div>
      <PageHead title="Stock Reports" icon="Warehouse" subtitle="Yarn → Knitting → Grey fabric → Processing (dyeing, compacting…) → Finished fabric, and trims – with company, kg and rate per kg.">
        {can('yarnReceipt', 'create') && <button className="btn" onClick={() => nav('/m/yarnReceipt')}><Icon name="Package" size={15} /> Yarn Inward</button>}
        {can('knitting', 'create') && <button className="btn" onClick={() => nav('/m/knitting')}><Icon name="Waypoints" size={15} /> Knitting</button>}
        {can('fabricProcess', 'create') && <button className="btn" onClick={() => nav('/m/fabricProcess')}><Icon name="Droplets" size={15} /> Processing</button>}
      </PageHead>
      <Tabs tabs={TABS} value={tab} onChange={(t) => setSp({ t })} />

      {tab === 'overview' ? (
        !overview ? <div className="center-page"><Spinner /></div> : (
          <>
            <Card title="Fabric stock chain" icon="Workflow">
              <div className="pipeline" style={{ alignItems: 'stretch' }}>
                {CHAIN.map((c, i) => {
                  const d = overview.chain[c.key];
                  const total = d.totals[c.total] || 0;
                  return (
                    <div key={c.key} className="row" style={{ flex: 1, minWidth: 180 }}>
                      <div className="card kpi tone-primary rise" style={{ flex: 1, cursor: 'pointer', animationDelay: `${i * 60}ms` }} onClick={() => setSp({ t: c.key })}>
                        <div className="ico"><Icon name={c.icon} size={18} /></div>
                        <div className="lbl">{c.label}</div>
                        <div className="val val-text" style={{ fontSize: 22 }}>{fmtNum(total, c.unit === 'kg' ? 1 : 0)}{c.unit === 'kg' && <span className="small muted"> kg</span>}</div>
                        <div className="sub">{c.unit === 'kg' ? 'balance in stock' : 'trims stock value'} · {d.rows.length} line(s)</div>
                      </div>
                      {i < CHAIN.length - 1 && <Icon name="ChevronRight" size={20} style={{ color: 'var(--muted)', flex: 'none' }} />}
                    </div>
                  );
                })}
              </div>
            </Card>
            <div className="kpis mt">
              <Kpi label="Yarn issued to knitting" value={overview.knitting.totals.yarnIssuedKg || 0} format={(v) => `${fmtNum(v, 0)} kg`} icon="Waypoints" tone="accent" />
              <Kpi label="Grey received" value={overview.knitting.totals.greyReceivedKg || 0} format={(v) => `${fmtNum(v, 0)} kg`} icon="Layers" tone="green" />
              <Kpi label="Pending at knitters" value={overview.knitting.totals.pendingKg || 0} format={(v) => `${fmtNum(v, 0)} kg`} icon="Hourglass" tone="amber" />
              <Kpi label="Pending at processors" value={overview.processing.totals.pendingKg || 0} format={(v) => `${fmtNum(v, 0)} kg`} icon="Hourglass" tone="amber" />
              <Kpi label="Knitting charges" value={overview.knitting.totals.amount || 0} format={(v) => fmtNum(v, 0)} icon="Coins" tone="violet" />
              <Kpi label="Processing charges" value={overview.processing.totals.amount || 0} format={(v) => fmtNum(v, 0)} icon="Coins" tone="violet" />
            </div>
            <div className="grid g2 mt">
              <StockTable data={overview.knitting} compact />
              <StockTable data={overview.processing} compact />
            </div>
          </>
        )
      ) : (
        <>
          <Card title="Filters" icon="SlidersHorizontal">
            <div className="form-grid">
              <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
              <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
              <Field label="Job No"><input placeholder="GAR-2026-00001" value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} /></Field>
              <Field label="Company name"><input placeholder="Supplier / knitter / processor" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>
              {tab === 'processing' && <Field label="Process"><select value={f.process} onChange={(e) => setF({ ...f, process: e.target.value })}><option value="">All processes</option>{PROCESS_TYPES.map((p) => <option key={p}>{p}</option>)}</select></Field>}
            </div>
            <div className="row-wrap mt">
              <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : <Icon name="Play" size={15} />} Run report</button>
              <div className="grow" />
              {data && <button className="btn" onClick={() => reportPdf(data.title, data.columns, [...data.rows, { [data.columns[0].key]: 'TOTAL', ...data.totals }], filterText)}><Icon name="FileDown" size={15} /> PDF</button>}
              {can('stock', 'export') && <>
                <button className="btn" onClick={() => exportAs('xlsx')}><Icon name="FileSpreadsheet" size={15} /> Excel</button>
                <button className="btn" onClick={() => exportAs('csv')}>CSV</button>
              </>}
              {data && <button className="btn" onClick={() => window.print()}><Icon name="Printer" size={15} /> Print</button>}
            </div>
          </Card>
          <div className="mt">{data ? <StockTable data={data} /> : <div className="center-page"><Spinner /></div>}</div>
        </>
      )}
    </div>
  );
}

function StockTable({ data, compact }) {
  return (
    <Card title={data.title} icon="Table" pad={false}>
      {!data.rows.length ? <Empty icon="Warehouse" title="No stock movements for these filters" /> : (
        <table className={`tbl ${compact ? 'tbl-mini' : ''}`}>
          <thead><tr>{data.columns.map((c, i) => <th key={c.key} className={i && isNum(data.rows[0][c.key]) ? 'num' : ''}>{c.label}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i}>{data.columns.map((c) => {
                const v = r[c.key];
                const neg = isNum(v) && v < 0;
                return <td key={c.key} className={isNum(v) ? 'num' : ''} style={neg || (c.key === 'balanceKg' && v < 0) ? { color: 'var(--red)', fontWeight: 650 } : c.key.startsWith('balance') ? { fontWeight: 650 } : undefined}>
                  {isNum(v) ? fmtNum(v, MONEY.includes(c.key) || c.key.toLowerCase().includes('rate') ? 2 : Number.isInteger(v) ? 0 : 2) : v}
                </td>;
              })}</tr>
            ))}
          </tbody>
          <tfoot>
            <tr>{data.columns.map((c, i) => <td key={c.key} className={data.totals[c.key] !== undefined ? 'num' : ''}>{i === 0 ? 'TOTAL' : data.totals[c.key] !== undefined ? fmtNum(data.totals[c.key], Number.isInteger(data.totals[c.key]) ? 0 : 2) : ''}</td>)}</tr>
          </tfoot>
        </table>
      )}
    </Card>
  );
}
