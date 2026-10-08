/**
 * Create / view / edit any module record:
 * job-linked prefill (no re-entry), live calculations, status engine actions,
 * overrides with mandatory reason, soft delete / restore, PDFs, history.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { applyCompute, validateRecord, allowedTransitions } from '@shared/modules/index.js';
import { api, errMsg, needsOverride } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from './Feedback.jsx';
import { FormRenderer, RefSelect } from './FormRenderer.jsx';
import { Drawer, Icon, StatusBadge, Badge, Field, Modal, Tabs, Spinner } from './ui.jsx';
import { fmtDate, fmtDateTime, fmtNum } from '../utils/format.js';
import { quotationPdf, packingListPdf, ppMeetingPdf, commercialInvoicePdf, savePdfToDocuments } from '../utils/pdf.js';

const APPROVAL = ['Approved', 'Final Approved', 'Rejected', 'Verified', 'Reconciled', 'Passed', 'Failed'];
const strip = (o) => {
  const out = { ...o };
  Object.keys(out).forEach((k) => { if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && out[k]._id) out[k] = out[k]._id; });
  return out;
};

export default function RecordDrawer({ def, id, initialJob, onClose, onSaved }) {
  const { can, user } = useAuth();
  const { toast, askReason, confirm } = useFeedback();
  const nav = useNavigate();
  const isNew = !id;
  const [rec, setRec] = useState(null);
  const [values, setValues] = useState({});
  const [job, setJob] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('details');
  const [history, setHistory] = useState([]);
  const [convert, setConvert] = useState(null);
  const [impact, setImpact] = useState(null);
  const [versions, setVersions] = useState([]);

  const editable = isNew ? can(def.key, 'create') : can(def.key, 'edit') && !['Closed', 'Fabric Job Closed', 'Cancelled', 'Converted'].includes(rec?.status) && !rec?.isDeleted;

  const load = async () => {
    if (isNew) {
      const defaults = Object.fromEntries(def.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
      setValues({ ...defaults, status: def.defaultStatus });
      if (initialJob) pickJob(initialJob);
      return;
    }
    const { data } = await api.get(`/m/${def.key}/${id}`);
    setRec(data);
    setValues(strip(data));
    if (data.jobNo && def.jobLinked) api.get(`/lookup/job/${data.jobNo}`).then((r) => setJob(r.data)).catch(() => {});
  };
  useEffect(() => { load().catch((e) => toast(errMsg(e), 'err')); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'history' && rec) api.get('/admin/audit', { params: { recordId: rec._id, limit: 50 } }).then((r) => setHistory(r.data.rows)).catch(() => setHistory([]));
    if (tab === 'versions' && rec) api.get(`/quotations/${rec._id}/versions`).then((r) => setVersions(r.data)).catch(() => {});
  }, [tab, rec]);

  async function pickJob(jobNo) {
    if (!jobNo) { setJob(null); return; }
    try {
      const { data } = await api.get(`/lookup/job/${jobNo}`);
      setJob(data);
      // carry job data forward – no duplicate entry
      if (def.prefill) setValues((v) => ({ ...v, ...Object.fromEntries(Object.entries(def.prefill(data)).filter(([, x]) => x !== undefined && x !== null)) }));
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  const computed = useMemo(() => applyCompute(def, values), [def, values]);
  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  async function save(overrideReason) {
    const errs = validateRecord(def, computed);
    if (def.jobLinked === true && isNew && !job) errs._job = 'Select a Job No';
    setErrors(errs);
    if (Object.keys(errs).length) { toast('Please fix the highlighted fields', 'warn'); return; }
    setBusy(true);
    try {
      const body = { ...values, ...(job ? { job: job._id } : {}), ...(overrideReason ? { _override: { reason: overrideReason } } : {}) };
      let data;
      if (def.isJob) {
        if (isNew) data = (await api.post('/jobs', body)).data;
        else {
          const r = await api.put(`/jobs/${rec._id}`, body);
          data = r.data.job;
          if (r.data.impact?.length) setImpact(r.data.impact);
        }
      } else if (isNew) data = (await api.post(`/m/${def.key}`, body)).data;
      else data = (await api.put(`/m/${def.key}/${rec._id}`, body)).data;
      toast(isNew ? `${def.singular} ${data.jobNo && def.isJob ? data.jobNo : data.refNo} created` : 'Saved');
      onSaved?.(data);
      if (isNew) { onClose(); if (def.isJob) nav(`/jobs/${data.jobNo}`); } else { setRec({ ...rec, ...data }); setValues(strip(data)); }
    } catch (e) {
      if (needsOverride(e) && can(def.key, 'override')) {
        const reason = await askReason(`${errMsg(e)}\n\nYou have override permission. Provide a reason to proceed.`, { title: 'Authorised override', confirmLabel: 'Override & save' });
        if (reason) { setBusy(false); await save(reason); return; }
      } else {
        toast(errMsg(e), 'err');
        if (e.response?.data?.details && !e.response.data.details.code) setErrors(e.response.data.details);
      }
    } finally { setBusy(false); }
  }

  async function changeStatus(to, { override = false } = {}) {
    let reason = '';
    if (override || ['Cancelled', 'On Hold', 'Rejected', 'Failed'].includes(to)) {
      reason = await askReason(`Change status of ${rec.refNo || rec.jobNo} from "${rec.status}" to "${to}".`, { title: override ? 'Override status' : `Mark as ${to}`, optional: !override && !['Cancelled', 'On Hold'].includes(to) });
      if (reason === null) return;
    }
    try {
      const url = def.isJob ? `/jobs/${rec._id}/status` : `/m/${def.key}/${rec._id}/status`;
      const { data } = await api.post(url, { status: to, reason });
      setRec((r) => ({ ...r, ...data, _transitions: allowedTransitions(def, data.status) }));
      setValues(strip(data));
      toast(`Status → ${data.status}`);
      onSaved?.(data);
    } catch (e) {
      if (needsOverride(e) && can(def.key, 'override') && !override) return changeStatus(to, { override: true });
      toast(errMsg(e), 'err');
    }
    return null;
  }

  async function remove() {
    const reason = await askReason(`Delete ${def.singular} ${rec.refNo || rec.jobNo}? It can be restored by Admin from the Recycle Bin.`, { title: 'Delete record', confirmLabel: 'Delete', danger: true });
    if (reason === null) return;
    try {
      await api.delete(def.isJob ? `/jobs/${rec._id}` : `/m/${def.key}/${rec._id}`, { data: { reason } });
      toast('Deleted');
      onSaved?.(); onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function restore() {
    try { await api.post(def.isJob ? `/jobs/${rec._id}/restore` : `/m/${def.key}/${rec._id}/restore`); toast('Restored'); onSaved?.(); onClose(); } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function pdf(save) {
    const fullJob = job || (rec?.jobNo ? (await api.get(`/lookup/job/${rec.jobNo}`)).data : null);
    const r = { ...rec, ...computed };
    const map = {
      quotation: () => [quotationPdf(r, save ? 'blob' : undefined), 'Other', `Quotation ${r.refNo} v${r.version}`],
      packingList: () => [packingListPdf(r, fullJob, save ? 'blob' : undefined), 'Packing List', `Packing List ${r.refNo}`],
      ppMeeting: () => [ppMeetingPdf(r, save ? 'blob' : undefined), 'Other', `PP Meeting Report ${r.jobNo}`],
      commercialInvoice: () => [commercialInvoicePdf(r, fullJob, save ? 'blob' : undefined), 'Commercial Invoice', `Commercial Invoice ${r.invoiceNo}`],
    };
    const [blob, docType, title] = map[def.pdf]();
    if (save && r.jobNo) {
      try { await savePdfToDocuments(blob, { job: r.jobNo, docType, title }); toast(`${title} saved to Documents`); } catch (e) { toast(errMsg(e), 'err'); }
    }
  }

  async function revise() {
    if (!(await confirm(`Create a new version of ${rec.refNo}? The current version will be marked "Revised".`))) return;
    try { const { data } = await api.post(`/quotations/${rec._id}/revise`); toast(`Version ${data.version} created (${data.refNo})`); onSaved?.(); onClose(); } catch (e) { toast(errMsg(e), 'err'); }
  }

  if (!isNew && !rec) return <Drawer title={def.singular} onClose={onClose}><div className="center-page"><Spinner /></div></Drawer>;

  const transitions = rec?._transitions || (rec ? allowedTransitions(def, rec.status) : []);
  const closeStatuses = (def.closeStatuses || []).filter(() => !def.isJob);
  const checks = def.key === 'fabricBooking' ? def.compute(values).closureChecks : null;

  return (
    <Drawer
      title={isNew ? `New ${def.singular}` : `${def.singular} ${def.isJob ? rec.jobNo : rec.refNo}`}
      subtitle={!isNew && [rec.jobNo && !def.isJob ? `Job ${rec.jobNo}` : null, rec.buyerName, rec.styleNo && `Style ${rec.styleNo}`].filter(Boolean).join(' · ')}
      headExtra={!isNew && <StatusBadge status={rec.status} />}
      onClose={onClose}
      footer={(
        <>
          {!isNew && !rec.isDeleted && can(def.key, 'delete') && <button className="btn btn-danger" onClick={remove}><Icon name="Trash2" size={15} /> Delete</button>}
          {!isNew && rec.isDeleted && user.isAdmin && <button className="btn" onClick={restore}><Icon name="RotateCcw" size={15} /> Restore</button>}
          <div className="grow" />
          <button className="btn" onClick={onClose}>Close</button>
          {editable && <button className="btn btn-primary" disabled={busy} onClick={() => save()}>{busy ? <Spinner /> : <Icon name="Save" size={15} />} {isNew ? 'Create' : 'Save changes'}</button>}
        </>
      )}
    >
      {rec?.isDeleted && <div className="alert alert-red mb"><Icon name="Trash2" /> This record is deleted ({rec.deleteReason || 'no reason'}).</div>}

      {/* Status engine */}
      {!isNew && !rec.isDeleted && (
        <div className="card card-pad mb">
          <div className="row-wrap">
            <div className="grow">
              <div className="muted small">Current status</div>
              <div className="row" style={{ marginTop: 4 }}><StatusBadge status={rec.status} />
                {rec.closureVerdict && <Badge tone={String(rec.closureVerdict).startsWith('READY') ? 'violet' : rec.closureVerdict === 'CLOSED' ? 'green' : 'grey'}>{rec.closureVerdict}</Badge>}
              </div>
            </div>
            {can(def.key, 'edit') && transitions.filter((t) => !(def.isJob && t === 'Ready to Close')).map((t) => (
              <button key={t} className={`btn btn-sm ${['Rejected', 'Failed', 'Cancelled'].includes(t) ? 'btn-danger' : APPROVAL.includes(t) ? 'btn-success' : ''}`} disabled={APPROVAL.includes(t) && !can(def.key, 'approve')} onClick={() => changeStatus(t)}>
                <Icon name="ArrowRight" size={14} /> {t}
              </button>
            ))}
            {can(def.key, 'close') && closeStatuses.map((t) => (
              <button key={t} className={`btn btn-sm ${String(rec.closureVerdict || '').startsWith('READY') || def.key !== 'fabricBooking' ? 'btn-primary' : ''}`} onClick={() => changeStatus(t)} title={def.key === 'fabricBooking' && !String(rec.closureVerdict || '').startsWith('READY') ? 'Not ready – requires override with reason' : undefined}><Icon name="Lock" size={14} /> {t}</button>
            ))}
            {can(def.key, 'override') && (
              <select style={{ width: 170, height: 30 }} value="" onChange={(e) => e.target.value && changeStatus(e.target.value, { override: true })} title="Admin override (reason required)">
                <option value="">Override status…</option>
                {[...def.statuses, ...(def.closeStatuses || [])].filter((s) => s !== rec.status && !(def.isJob && ['Ready to Close', 'Closed'].includes(s))).map((s) => <option key={s}>{s}</option>)}
              </select>
            )}
            {def.pdf && <><button className="btn btn-sm" onClick={() => pdf(false)}><Icon name="FileDown" size={14} /> PDF</button>
              {rec.jobNo && can('documents', 'create') && <button className="btn btn-sm" onClick={() => pdf(true)} title="Generate and store in Documents"><Icon name="FolderUp" size={14} /> Save to Docs</button>}</>}
            {def.key === 'quotation' && rec.status === 'Approved' && can('orders', 'create') && <button className="btn btn-sm btn-success" onClick={() => setConvert({ poNo: '', shipmentDate: '', orderDate: new Date().toISOString().slice(0, 10), destination: '' })}><Icon name="BadgeCheck" size={14} /> Confirm Order</button>}
            {def.key === 'quotation' && !['Converted', 'Revised'].includes(rec.status) && can('quotation', 'create') && <button className="btn btn-sm" onClick={revise}><Icon name="GitBranch" size={14} /> Revise</button>}
            {(rec.jobNo) && <button className="btn btn-sm" onClick={() => nav(`/jobs/${rec.jobNo}`)}><Icon name="RadioTower" size={14} /> Control Tower</button>}
          </div>
        </div>
      )}

      {impact && (
        <div className="alert alert-info mb" style={{ display: 'block' }}>
          <b>Order change impact</b>
          <ul className="fw-list">{impact.map((i, k) => <li key={k}>{i.module} {i.refNo || ''}: {i.action}</li>)}</ul>
        </div>
      )}

      {!isNew && <Tabs value={tab} onChange={setTab} tabs={[{ key: 'details', label: 'Details' }, { key: 'history', label: 'History & Audit' }, ...(def.key === 'quotation' ? [{ key: 'versions', label: 'Versions' }] : [])]} />}

      {tab === 'details' && (
        <>
          {def.jobLinked && (
            <div className="card card-pad mb">
              <div className="form-grid">
                <Field label="Job No" required={def.jobLinked === true} error={errors._job} hint={isNew ? 'Selecting a job pulls order data automatically' : undefined}>
                  {isNew ? <RefSelect refModel="Job" value={job?._id} params={{ open: 'true' }} onChange={(v) => !v && setJob(null)} onPick={(it) => pickJob(it.jobNo)} placeholder="Search Job No / Style / PO…" />
                    : <input readOnly value={rec.jobNo || '—'} />}
                </Field>
                {job && <>
                  <Field label="Buyer"><input readOnly value={job.buyerName || ''} /></Field>
                  <Field label="Style / PO"><input readOnly value={`${job.styleNo} / ${job.poNo}`} /></Field>
                  <Field label="Order Qty"><input readOnly value={fmtNum(job.orderQty)} /></Field>
                </>}
              </div>
            </div>
          )}
          {checks && (
            <div className="card card-pad mb">
              <div className="row" style={{ marginBottom: 8 }}><Icon name="ListChecks" size={16} /><b>Fabric job closure checks</b><div className="grow" /><Badge tone={String(computed.closureVerdict).startsWith('READY') ? 'violet' : 'grey'}>{computed.closureVerdict}</Badge></div>
              <div className="row-wrap">{checks.map((c) => <span key={c.label} className={`badge ${c.ok ? 'b-green' : 'b-grey'}`}>{c.label}</span>)}</div>
            </div>
          )}
          <div className="card card-pad">
            <FormRenderer def={def} values={computed} onChange={set} errors={errors} disabled={!editable} jobNo={job?.jobNo || rec?.jobNo} />
          </div>
        </>
      )}

      {tab === 'history' && (
        <div className="grid g2">
          <div className="card card-pad">
            <h3 className="mb">Status history</h3>
            <div className="timeline">
              {(rec.statusHistory || []).slice().reverse().map((h, i) => (
                <div key={i} className={`tl-item ${h.override ? 'red' : ''}`}>
                  <div><b>{h.from || 'Created'}</b> → <b>{h.to}</b> {h.override && <Badge tone="red">override</Badge>}</div>
                  <div className="muted small">{h.byName} · {fmtDateTime(h.at)}</div>
                  {h.reason && <div className="small">{h.reason}</div>}
                </div>
              ))}
            </div>
          </div>
          <div className="card card-pad">
            <h3 className="mb">Audit trail</h3>
            <div className="timeline">
              {history.map((h) => (
                <div key={h._id} className={`tl-item ${['OVERRIDE', 'DELETE'].includes(h.action) ? 'red' : ''}`}>
                  <div className="small"><Badge tone="primary" dot={false}>{h.action}</Badge> {h.message}</div>
                  <div className="muted small">{fmtDateTime(h.createdAt)} · {h.ip || ''}</div>
                  {h.reason && <div className="small">Reason: {h.reason}</div>}
                </div>
              ))}
              {!history.length && <div className="muted small">No audit entries</div>}
            </div>
          </div>
        </div>
      )}

      {tab === 'versions' && (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Ref</th><th>Version</th><th>Date</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Value</th><th>Status</th></tr></thead>
            <tbody>{versions.map((v) => <tr key={v._id} style={v._id === rec._id ? { background: 'var(--primary-50)' } : undefined}><td className="mono">{v.refNo}</td><td>v{v.version}</td><td>{fmtDate(v.quoteDate)}</td><td className="num">{fmtNum(v.orderQty)}</td><td className="num">{fmtNum(v.price, 2)}</td><td className="num">{fmtNum(v.quoteValue, 2)}</td><td><StatusBadge status={v.status} /></td></tr>)}</tbody>
          </table>
        </div>
      )}

      {convert && (
        <Modal
          title="Confirm order from quotation"
          onClose={() => setConvert(null)}
          footer={<><button className="btn" onClick={() => setConvert(null)}>Cancel</button>
            <button className="btn btn-success" onClick={async () => {
              try {
                const { data } = await api.post(`/jobs/from-quotation/${rec._id}`, convert);
                toast(`Order confirmed – Job ${data.jobNo} generated with T&A, fabric, trims, PP meeting, samples & plan`);
                setConvert(null); onSaved?.(); onClose(); nav(`/jobs/${data.jobNo}`);
              } catch (e) { toast(errMsg(e), 'err'); }
            }}><Icon name="BadgeCheck" size={15} /> Confirm & generate Job No</button></>}
        >
          <p className="muted small">Buyer, style, quantity, price, terms and fabric are pulled from the quotation & costing. Only the order-specific details below are needed.</p>
          <div className="form-grid">
            <Field label="PO No" required><input value={convert.poNo} onChange={(e) => setConvert({ ...convert, poNo: e.target.value })} /></Field>
            <Field label="Order Date"><input type="date" value={convert.orderDate} onChange={(e) => setConvert({ ...convert, orderDate: e.target.value })} /></Field>
            <Field label="Shipment Date" required><input type="date" value={convert.shipmentDate} onChange={(e) => setConvert({ ...convert, shipmentDate: e.target.value })} /></Field>
            <Field label="Destination"><input value={convert.destination} onChange={(e) => setConvert({ ...convert, destination: e.target.value })} /></Field>
            <Field label="Order Qty (blank = quoted)"><input type="number" value={convert.orderQty || ''} onChange={(e) => setConvert({ ...convert, orderQty: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Drawer>
  );
}
