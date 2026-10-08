/** JOB CONTROL TOWER – the whole order journey for one Job No. */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { MODULES } from '@shared/modules/index.js';
import { api, errMsg } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { Icon, Card, Badge, StatusBadge, Progress, Loading, Empty, PageHead, Modal, Field, Kpi } from '../components/ui.jsx';
import { RefSelect } from '../components/FormRenderer.jsx';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { fmtDate, fmtDateTime, fmtNum, fmtMoney, STAGE_LABEL } from '../utils/format.js';

const STATE = {
  done: ['Check', 'Completed', 'green'], active: ['Loader', 'In progress', 'amber'], delayed: ['AlertTriangle', 'Delayed', 'red'],
  pending: ['Circle', 'Pending', 'grey'], na: ['Minus', 'Not applicable', 'grey'],
};
/** stage → [records key, module key, summary renderer] */
const STAGE_RECORDS = {
  enquiry: ['enquiry', 'enquiry', (r) => fmtDate(r.enquiryDate)],
  costing: ['costing', 'costing', (r) => `Cost ${fmtNum(r.totalCostPerPc, 3)} · FOB ${fmtNum(r.sellingPrice, 3)} · ${r.profitPct}%`],
  quotation: ['quotation', 'quotation', (r) => `v${r.version} · ${fmtNum(r.price, 3)}`],
  spec: ['techSpec', 'techSpec', (r) => `Rev ${r.revision || 1} · base ${r.baseSize || '—'} · ${r.pomCount || 0} POMs`],
  bom: ['bom', 'bom', (r) => `Rev ${r.revision || 1} · ${(r.lines || []).length} lines · ${fmtNum(r.materialCostPerPc, 3)}/pc${r.materialVariancePerPc ? ` (${r.materialVariancePerPc > 0 ? '+' : ''}${fmtNum(r.materialVariancePerPc, 3)} vs costing)` : ''}`],
  cad: ['pattern', 'pattern', (r) => `${r.patternNo} · ${r.cadSystem || 'CAD'} ${r.cadFileName ? `· ${r.cadFileName}` : ''}`],
  pattern: ['pattern', 'pattern', (r) => `${r.patternNo} rev ${r.revision || 1} · ${r.patternType || ''}`],
  grading: ['pattern', 'pattern', (r) => `${r.patternNo} · ${r.gradedSizes || 0} sizes graded`],
  marker: ['marker', 'marker', (r) => `${r.markerNo} · ${r.ratio || ''} · ${fmtNum(r.consumptionPerPc, 4)}/pc${r.consumptionVariancePct ? ` (${r.consumptionVariancePct > 0 ? '+' : ''}${r.consumptionVariancePct}% vs BOM)` : ''}`],
  tna: ['tna', 'tna', (r) => `${r.completionPct}% complete · ${r.delayedCount} delayed`],
  ppMeeting: ['ppMeeting', 'ppMeeting', (r) => fmtDate(r.meetingDate)],
  fabric: ['fabricBooking', 'fabricBooking', (r) => `${r.fabricType} · req ${fmtNum(r.requiredQty, 1)} / rcvd ${fmtNum(r.receivedQty, 1)} ${r.unit}`],
  trims: ['trimBooking', 'trimBooking', (r) => `${r.item} · ${fmtNum(r.receivedQty)}/${fmtNum(r.bookingQty)}`],
  sampling: ['sample', 'sample', (r) => r.sampleType],
  approval: ['sample', 'sample', (r) => r.sampleType],
  planning: ['productionPlan', 'productionPlan', (r) => `${r.line || 'No line'} · ${fmtNum(r.dailyTarget)}/day · ${r.achievementPct || 0}%`],
  cutting: ['cutting', 'cutting', (r) => `${fmtDate(r.entryDate)} · ${fmtNum(r.cutQty)} pcs`],
  sewing: ['sewing', 'sewing', (r) => `${fmtDate(r.entryDate)} · ${r.line} · ${fmtNum(r.actualQty)} pcs · ${r.efficiencyPct}%`],
  finishing: ['finishing', 'finishing', (r) => `${fmtDate(r.entryDate)} · ${fmtNum(r.passedQty)} passed`],
  packing: ['packing', 'packing', (r) => `${fmtNum(r.totalCartons)} ctns · ${fmtNum(r.totalQty)} pcs`],
  inspection: ['inspection', 'inspection', (r) => `${r.inspectionType} · ${r.aqlResult || '—'}`],
  shipment: ['shipment', 'shipment', (r) => `${r.mode} · ${fmtNum(r.qty)} pcs · ${r.blAwbNo || ''}`],
  accounts: ['invoice', 'invoice', (r) => `${r.invoiceNo} · ${fmtNum(r.totalAmount, 2)} · O/S ${fmtNum(r.outstanding, 2)}`],
  payment: ['payment', 'payment', (r) => `${fmtDate(r.paymentDate)} · ${fmtNum(r.amount, 2)}`],
};

function JobSearch() {
  const nav = useNavigate();
  const { user } = useAuth();
  return (
    <div>
      <PageHead title={`Job 360 / Control Tower · ${user.unit.name}`} icon="RadioTower" subtitle="Enter a Job No to see the complete order journey – enquiry, specification, BOM, pattern, marker, production, shipment, accounts and closure." />
      <div className="card card-pad" style={{ maxWidth: 640 }}>
        <Field label="Job No / Style / PO / Buyer">
          <RefSelect refModel="Job" onChange={() => {}} onPick={(it) => nav(`/jobs/${it.jobNo}`)} placeholder={`e.g. ${user.unit.prefix}-${user.unit.code === 'U2' ? 3000 : 1000}`} />
        </Field>
      </div>
    </div>
  );
}

export default function ControlTower() {
  const { jobNo } = useParams();
  if (!jobNo) return <JobSearch />;
  return <Tower key={jobNo} jobNo={jobNo} />;
}

function Tower({ jobNo }) {
  const { can, user } = useAuth();
  const { toast, askReason } = useFeedback();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null); // { def, id }
  const [subForm, setSubForm] = useState(null);
  const [stageFocus, setStageFocus] = useState(null);

  const load = () => api.get(`/jobs/track/${encodeURIComponent(jobNo)}`).then((r) => setD(r.data)).catch((e) => setErr(errMsg(e)));
  useEffect(() => { load(); }, [jobNo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <Empty icon="SearchX" title={err}><Link to="/control-tower">Search another job</Link></Empty>;
  if (!d) return <Loading />;
  const { job, lifecycle: lc, records, profit } = d;
  const isMain = job.isForecast && lc.meta.subJobs?.length;
  const current = lc.order.find((s) => s.key === lc.currentStage);

  async function closeJob() {
    let reason = '';
    if (!lc.readyToClose) {
      reason = await askReason(`Job is NOT ready to close:\n• ${lc.blockers.join('\n• ')}\n\nClosing now is an override and will be audited.`, { title: 'Override job closure', confirmLabel: 'Close with override', danger: true });
      if (reason === null) return;
    } else {
      reason = await askReason(`Close ${job.jobNo}? All conditions are met. Records stay available for history.`, { title: 'Close job', label: 'Closure remarks', optional: true, confirmLabel: 'Close job' });
      if (reason === null) return;
    }
    try { await api.post(`/jobs/${job._id}/close`, { reason, remarks: reason }); toast(`JOB CLOSED: ${job.jobNo}`); load(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function reopen() {
    const reason = await askReason(`Reopen ${job.jobNo}?`, { title: 'Reopen job' });
    if (reason === null) return;
    try { await api.post(`/jobs/${job._id}/reopen`, { reason }); toast('Job reopened'); load(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function approveOutstanding(approved) {
    const reason = await askReason(approved ? 'Approve the remaining outstanding amount as acceptable for job closure?' : 'Revoke the outstanding approval?', { title: 'Outstanding approval' });
    if (reason === null) return;
    try { await api.post(`/jobs/${job._id}/approve-outstanding`, { approved, reason }); toast('Updated'); load(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function regenerate() {
    try { const r = await api.post(`/jobs/${job._id}/regenerate`); toast(`${r.data.created} missing record(s) generated`); load(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function createSubs() {
    try {
      await api.post(`/jobs/${job._id}/subjobs`, { subJobs: subForm.rows.filter((r) => Number(r.orderQty) > 0) });
      toast('Sub jobs created'); setSubForm(null); load();
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function editSubQty(s) {
    const qty = window.prompt(`New quantity for ${s.jobNo}`, s.qty);
    if (!qty) return;
    const reason = await askReason(`Change ${s.jobNo} quantity from ${s.qty} to ${qty}.`, { title: 'Change sub job quantity' });
    if (reason === null) return;
    try { await api.put(`/jobs/${job._id}/subjobs/${s._id}`, { orderQty: Number(qty), reason }); toast('Quantity updated'); load(); } catch (e) { toast(errMsg(e), 'err'); }
  }

  const prod = lc.meta.production;
  const focusStage = stageFocus || lc.currentStage;

  return (
    <div>
      <PageHead
        icon="RadioTower"
        crumbs={<><Link to="/control-tower">Control Tower</Link> {d.parent && <>/ <Link to={`/jobs/${d.parent.jobNo}`}>{d.parent.jobNo}</Link></>}</>}
        title={<span className="mono">{job.jobNo}</span>}
        subtitle={<>{job.buyerName} · Style <b>{job.styleNo}</b> · PO <b>{job.poNo}</b> · Order {job.orderNo}</>}
      >
        <StatusBadge status={job.status} />
        {isMain && <Badge tone="violet">Forecast main job</Badge>}
        {job.parentJobNo && <Badge tone="blue">Sub job of {job.parentJobNo}</Badge>}
        <button className="btn" onClick={() => setOpen({ def: MODULES.orders, id: job._id })}><Icon name="FileText" size={15} /> Order details</button>
        {user.isAdmin && <button className="btn" onClick={regenerate} title="Generate any missing T&A, specification, BOM, fabric, trims, PPM, samples, plan"><Icon name="RefreshCcw" size={15} /> Regenerate</button>}
      </PageHead>

      {/* Headline */}
      <div className="kpis">
        <Kpi label="Order Qty" value={job.orderQty} icon="Shirt" tone="primary" sub={`${fmtMoney(job.orderValue, job.currency)}`} />
        <Kpi label="Overall Progress" value={job.progressPct} format={(v) => `${Math.round(v)}%`} icon="Activity" tone="green" sub={`Next: ${current?.label || 'Closure'}`} />
        <Kpi label="Shipment Date" value={fmtDate(job.shipmentDate)} icon="Ship" tone="blue" sub={job.destination} />
        {prod && <Kpi label="Cut / Sewn / Packed" value={`${fmtNum(prod.cut)} / ${fmtNum(prod.sewn)} / ${fmtNum(prod.packed)}`} icon="Factory" tone="accent" sub={`WIP ${fmtNum(prod.wip)}`} />}
        {lc.meta.preproduction?.bom && <Kpi label="BOM Material / pc" value={fmtNum(lc.meta.preproduction.bom.materialCostPerPc, 3)} icon="ListTree" tone={lc.meta.preproduction.bom.variancePerPc > 0 ? 'amber' : 'green'} sub={lc.meta.preproduction.bom.costedMaterialPerPc ? `Costed ${fmtNum(lc.meta.preproduction.bom.costedMaterialPerPc, 3)}` : `${lc.meta.preproduction.bom.status}${lc.meta.preproduction.bom.unbooked ? ` · ${lc.meta.preproduction.bom.unbooked} unbooked` : ''}`} />}
        {lc.meta.preproduction?.markers > 0 && <Kpi label="Marker Cons. / pc" value={fmtNum(lc.meta.preproduction.markerConsumption, 4)} icon="Ruler" tone={lc.meta.preproduction.markerVariancePct > 3 ? 'red' : 'green'} sub={`${lc.meta.preproduction.markerVariancePct > 0 ? '+' : ''}${lc.meta.preproduction.markerVariancePct}% vs BOM`} />}
        {lc.meta.fabric && <Kpi label="Fabric Received" value={`${fmtNum(lc.meta.fabric.received, 0)} / ${fmtNum(lc.meta.fabric.required, 0)}`} icon="Layers" tone={lc.meta.fabric.shortage > 0 ? 'amber' : 'green'} sub={lc.meta.fabric.shortage > 0 ? `Shortage ${fmtNum(lc.meta.fabric.shortage, 1)}` : 'No shortage'} />}
        {lc.meta.payment && <Kpi label="Payment" value={`${fmtNum(lc.meta.payment.received, 0)} / ${fmtNum(lc.meta.payment.invoiced, 0)}`} icon="Wallet" tone="violet" sub={`Outstanding ${fmtNum(lc.meta.payment.outstanding, 2)}`} />}
      </div>

      {/* Lifecycle */}
      <Card className="mt" title="Order lifecycle" icon="Workflow" actions={<div className="row-wrap small">{Object.entries(STATE).slice(0, 4).map(([k, [, l, tone]]) => <Badge key={k} tone={tone}>{l}</Badge>)}</div>}>
        <div className="pipeline">
          {lc.order.map((s) => (
            <div key={s.key} className={`pipe-step ${s.state} ${s.key === lc.currentStage ? 'current' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setStageFocus(s.key)} title={`${s.label} – ${STATE[s.state][1]} (${s.department})`}>
              <div className="pipe-dot"><Icon name={STATE[s.state][0]} size={17} /></div>
              <div className="pipe-label">{STAGE_LABEL[s.key] || s.label}</div>
              <div className="pipe-state">{s.key === lc.currentStage && s.state !== 'done' ? 'Current' : STATE[s.state][1]}</div>
            </div>
          ))}
        </div>
        <div className="mt"><Progress value={job.progressPct} /></div>
      </Card>

      <div className="grid mt tower-grid">
        {/* Stage details */}
        <div className="col">
          <Card title={`Stage: ${lc.order.find((s) => s.key === focusStage)?.label || ''}`} icon="Crosshair"
            actions={STAGE_RECORDS[focusStage] && !isMain && can(STAGE_RECORDS[focusStage][1], 'view') && (
              <>
                <button className="btn btn-sm" onClick={() => nav(`/m/${STAGE_RECORDS[focusStage][1]}?job=${job.jobNo}`)}><Icon name="List" size={14} /> Open module</button>
                {can(STAGE_RECORDS[focusStage][1], 'create') && !['enquiry', 'costing', 'quotation'].includes(focusStage) && (
                  <button className="btn btn-sm btn-primary" onClick={() => setOpen({ def: MODULES[STAGE_RECORDS[focusStage][1]], id: null, job: job.jobNo })}><Icon name="Plus" size={14} /> Add entry</button>
                )}
              </>
            )}>
            {(() => {
              const s = lc.order.find((x) => x.key === focusStage);
              const conf = STAGE_RECORDS[focusStage];
              let rows = conf ? records[conf[0]] || [] : [];
              if (focusStage === 'approval') rows = rows.filter((r) => r.sampleType === 'PP Sample');
              return (
                <div>
                  <div className="row-wrap mb"><Badge tone={STATE[s?.state || 'pending'][2]}>{STATE[s?.state || 'pending'][1]}</Badge><span className="muted small">Responsible: {s?.department}{s?.responsibleUser ? ` · ${s.responsibleUser}` : ''}</span></div>
                  {focusStage === 'documentation' && (
                    <div>
                      {lc.meta.documentation.missing.length > 0 && <div className="alert alert-warn mb"><Icon name="FileWarning" size={16} /> Missing: {lc.meta.documentation.missing.join(', ')}</div>}
                      {records.documents.length ? records.documents.map((x) => <div key={x._id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}><Icon name="FileText" size={15} /> <b>{x.docType}</b> <span className="muted">{x.title} · v{x.currentVersion}</span></div>)
                        : <Empty icon="FolderOpen" title="No documents uploaded" />}
                      <button className="btn btn-sm mt" onClick={() => nav(`/documents?job=${job.jobNo}`)}><Icon name="Upload" size={14} /> Manage documents</button>
                    </div>
                  )}
                  {focusStage === 'profit' && profit && <ProfitPanel p={profit} />}
                  {focusStage === 'closure' && <ClosurePanel lc={lc} job={job} />}
                  {focusStage === 'order' && <div className="muted">Order confirmed {fmtDate(job.orderDate)} · {fmtNum(job.orderQty)} pcs × {fmtNum(job.unitPrice, 3)} {job.currency}</div>}
                  {conf && (rows.length ? (
                    <table className="tbl tbl-mini">
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r._id} className="click" onClick={() => setOpen({ def: MODULES[conf[1]], id: r._id })}>
                            <td className="mono link nowrap">{r.refNo}</td><td>{conf[2](r)}</td><td className="right"><StatusBadge status={r.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <Empty icon="Inbox" title={isMain ? 'Tracked on sub jobs' : 'No records yet'} />)}
                  {focusStage === 'tna' && records.tna[0] && <TnaGantt tna={records.tna[0]} />}
                </div>
              );
            })()}
          </Card>

          {isMain || (job.isForecast && user.isAdmin) ? (
            <Card title="Forecast sub jobs" icon="GitFork" actions={user.isAdmin && <button className="btn btn-sm btn-primary" onClick={() => setSubForm({ rows: [{ orderQty: '', shipmentDate: '' }] })}><Icon name="Plus" size={14} /> Add sub jobs</button>}>
              <div className="muted small mb">Main Job Qty = sum of sub jobs ({fmtNum(job.orderQty)} pcs · forecast {fmtNum(job.forecastQty)}). Only Admin can change the relationship or quantities.</div>
              {lc.meta.subJobs?.length ? (
                <table className="tbl tbl-mini">
                  <thead><tr><th>Sub Job</th><th className="num">Qty</th><th>Stage</th><th>Status</th>{user.isAdmin && <th />}</tr></thead>
                  <tbody>{lc.meta.subJobs.map((s) => (
                    <tr key={s._id}>
                      <td><Link className="mono" to={`/jobs/${s.jobNo}`}>{s.jobNo}</Link></td><td className="num">{fmtNum(s.qty)}</td>
                      <td style={{ minWidth: 140 }}><div className="small">{STAGE_LABEL[s.currentStage]}</div><Progress value={s.progressPct} /></td>
                      <td><StatusBadge status={s.status} /></td>
                      {user.isAdmin && <td><button className="btn btn-sm btn-ghost" onClick={() => editSubQty(s)}><Icon name="Pencil" size={13} /></button></td>}
                    </tr>
                  ))}</tbody>
                </table>
              ) : <Empty icon="GitFork" title="No sub jobs yet" />}
            </Card>
          ) : null}

          <Card title="All stages" icon="LayoutGrid">
            <div className="stage-list">
              {lc.order.map((s) => (
                <div key={s.key} className={`stage-card ${s.state}`} style={{ cursor: 'pointer' }} onClick={() => { setStageFocus(s.key); window.scrollTo({ top: 300, behavior: 'smooth' }); }}>
                  <div className="row"><b className="grow">{s.label}</b><Badge tone={STATE[s.state][2]}>{STATE[s.state][1]}</Badge></div>
                  <div className="muted small">{s.department}</div>
                  {STAGE_RECORDS[s.key] && <div className="small" style={{ marginTop: 4 }}>{(records[STAGE_RECORDS[s.key][0]] || []).length} record(s)</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right column */}
        <div className="col">
          <Card title="Job closure" icon="Lock">
            <ClosurePanel lc={lc} job={job} />
            <div className="row-wrap mt">
              {job.status !== 'Closed' && can('jobs', 'close') && (
                <button className={`btn ${lc.readyToClose ? 'btn-success' : ''}`} onClick={closeJob} disabled={!lc.readyToClose && !can('jobs', 'override')}>
                  <Icon name="Lock" size={15} /> {lc.readyToClose ? 'Close job' : 'Close with override'}
                </button>
              )}
              {job.status === 'Closed' && user.isAdmin && <button className="btn" onClick={reopen}><Icon name="LockOpen" size={15} /> Reopen</button>}
              {can('jobs', 'approve') && job.status !== 'Closed' && lc.meta.payment?.outstanding > 0 && (
                <button className="btn btn-sm" onClick={() => approveOutstanding(!job.outstandingApproved)}>
                  <Icon name="Stamp" size={14} /> {job.outstandingApproved ? 'Revoke outstanding approval' : 'Approve outstanding'}
                </button>
              )}
            </div>
          </Card>
          {profit && <Card title="Profit analysis" icon="TrendingUp"><ProfitPanel p={profit} compact /></Card>}
          <Card title="Activity timeline" icon="History">
            <div className="timeline" style={{ maxHeight: 460, overflow: 'auto' }}>
              {d.timeline.map((t) => (
                <div key={t._id} className={`tl-item ${['OVERRIDE', 'DELETE'].includes(t.action) ? 'red' : ['STATUS', 'CLOSE'].includes(t.action) ? '' : 'warn'}`}>
                  <div className="small">{t.message}</div>
                  <div className="muted small">{fmtDateTime(t.createdAt)} · {t.module}</div>
                </div>
              ))}
              {!d.timeline.length && <div className="muted small">No activity yet</div>}
            </div>
          </Card>
        </div>
      </div>

      {open && <RecordDrawer def={open.def} id={open.id} initialJob={open.job} onClose={() => setOpen(null)} onSaved={load} />}
      {subForm && (
        <Modal title={`Create sub jobs for ${job.jobNo}`} onClose={() => setSubForm(null)} width="min(620px, calc(100vw - 32px))"
          footer={<><button className="btn" onClick={() => setSubForm(null)}>Cancel</button><button className="btn btn-primary" onClick={createSubs}>Create sub jobs</button></>}>
          <div className="muted small mb">Each sub job gets its own T&A, fabric, trims, samples, production, shipment, accounts and closure.</div>
          {subForm.rows.map((r, i) => (
            <div key={i} className="form-grid mb">
              <Field label={`Sub job ${i + 1} qty`}><input type="number" value={r.orderQty} onChange={(e) => setSubForm({ rows: subForm.rows.map((x, j) => (j === i ? { ...x, orderQty: e.target.value } : x)) })} /></Field>
              <Field label="Shipment date"><input type="date" value={r.shipmentDate} onChange={(e) => setSubForm({ rows: subForm.rows.map((x, j) => (j === i ? { ...x, shipmentDate: e.target.value } : x)) })} /></Field>
            </div>
          ))}
          <button className="btn btn-sm" onClick={() => setSubForm({ rows: [...subForm.rows, { orderQty: '', shipmentDate: '' }] })}><Icon name="Plus" size={14} /> Another</button>
        </Modal>
      )}
    </div>
  );
}

function ClosurePanel({ lc, job }) {
  if (job.status === 'Closed') return <div className="alert alert-ok"><Icon name="Lock" size={16} /> <div><b>JOB CLOSED</b>{job.closedAt && <div className="small">{fmtDateTime(job.closedAt)} {job.closureRemarks ? `· ${job.closureRemarks}` : ''}</div>}</div></div>;
  if (lc.readyToClose) return <div className="alert alert-ok"><Icon name="BadgeCheck" size={16} /> <b>JOB READY FOR CLOSURE</b></div>;
  return (
    <div className="alert alert-warn" style={{ display: 'block' }}>
      <b className="row"><Icon name="ListTodo" size={16} /> Pending before closure</b>
      <ul className="fw-list">{lc.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
    </div>
  );
}

function ProfitPanel({ p, compact }) {
  const rows = [
    ['Order value', p.orderValue], ['Revenue (invoiced)', p.revenue],
    ...Object.entries(p.costs).map(([k, v]) => [`− ${k[0].toUpperCase()}${k.slice(1)} cost${p.costBasis?.[k] === 'standard' ? ' (std)' : ''}`, v]),
  ];
  return (
    <div>
      <table className="tbl tbl-mini">
        <tbody>
          {rows.map(([l, v]) => <tr key={l}><td>{l}</td><td className="num">{fmtNum(v, 2)}</td></tr>)}
          <tr><td><b>Actual profit</b></td><td className="num"><b style={{ color: p.actualProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtNum(p.actualProfit, 2)}</b></td></tr>
        </tbody>
      </table>
      <div className={`grid ${compact ? 'g2' : 'g4'} mt`}>
        <div className="chip">Expected {fmtNum(p.expectedProfit, 0)}</div>
        <div className="chip">Variance {fmtNum(p.profitVariance, 0)}</div>
        <div className="chip">Profit {p.profitPct}%</div>
        <div className="chip">Cost var. {fmtNum(p.costVariance, 0)}</div>
      </div>
      {Object.values(p.costBasis || {}).includes('standard') && <div className="muted small mt">(std) = no actual expense booked yet; costed standard used for produced qty.</div>}
    </div>
  );
}

function TnaGantt({ tna }) {
  const acts = tna.activities || [];
  if (!acts.length) return null;
  const dates = acts.flatMap((a) => [a.plannedDate, a.actualDate]).filter(Boolean).map((x) => new Date(x).getTime());
  const min = Math.min(...dates, Date.now()); const max = Math.max(...dates, Date.now());
  const pos = (x) => ((new Date(x).getTime() - min) / Math.max(max - min, 1)) * 100;
  const COLOR = { completed: 'var(--green)', delayed: 'var(--red)', inProgress: 'var(--amber)', notStarted: 'var(--grey)' };
  return (
    <div className="mt">
      <div className="form-section-title">T&A calendar</div>
      <div style={{ position: 'relative' }}>
        {acts.map((a) => (
          <div key={a.activity} className="row" style={{ height: 24 }}>
            <div className="small nowrap" style={{ width: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.activity}</div>
            <div style={{ flex: 1, position: 'relative', height: 10 }}>
              <div style={{ position: 'absolute', left: `${pos(a.plannedDate)}%`, width: 10, height: 10, marginLeft: -5, borderRadius: 3, background: COLOR[a.state] || 'var(--grey)' }} title={`${a.activity}: planned ${fmtDate(a.plannedDate)}${a.actualDate ? `, actual ${fmtDate(a.actualDate)}` : ''}${a.delayDays ? `, ${a.delayDays}d delay` : ''}`} />
              {a.actualDate && <div className="tna-bar" style={{ position: 'absolute', left: `${Math.min(pos(a.plannedDate), pos(a.actualDate))}%`, width: `${Math.abs(pos(a.actualDate) - pos(a.plannedDate))}%`, top: 1, height: 8, background: COLOR[a.state], opacity: 0.35 }} />}
            </div>
            <div className="small nowrap" style={{ width: 54, textAlign: 'right', color: a.delayDays ? 'var(--red)' : 'var(--muted)' }}>{a.delayDays ? `+${a.delayDays}d` : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
