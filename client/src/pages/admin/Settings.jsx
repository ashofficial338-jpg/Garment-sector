/** Workflow engine configuration + system settings (Admin). */
import { useEffect, useState } from 'react';
import { api, errMsg } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useFeedback } from '../../components/Feedback.jsx';
import { PageHead, Icon, Card, Field, Tabs, Loading, Badge } from '../../components/ui.jsx';
import { DEPARTMENTS, DOCUMENT_TYPES } from '@shared/constants.js';

export default function Settings() {
  const { user } = useAuth();
  const { toast } = useFeedback();
  const [s, setS] = useState(null);
  const [tab, setTab] = useState('workflow');
  const [users, setUsers] = useState([]);
  useEffect(() => {
    api.get('/admin/settings').then((r) => { setS(r.data); try { sessionStorage.setItem('company', JSON.stringify(r.data.company)); } catch { /* ignore */ } }).catch((e) => toast(errMsg(e), 'err'));
    api.get('/lookup/users').then((r) => setUsers(r.data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Loading />;
  const ro = !user.isAdmin;

  const save = async (key) => {
    try { const { data } = await api.put(`/admin/settings/${key}`, { value: s[key] }); setS({ ...s, [key]: data }); toast('Settings saved'); if (key === 'company') sessionStorage.setItem('company', JSON.stringify(data)); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const wf = s.workflow;
  const setWf = (i, patch) => setS({ ...s, workflow: wf.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const move = (i, d) => { const a = [...wf]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); setS({ ...s, workflow: a }); };
  const setObj = (key, k, v) => setS({ ...s, [key]: { ...s[key], [k]: v } });
  const SaveBtn = ({ k }) => !ro && <button className="btn btn-primary" onClick={() => save(k)}><Icon name="Save" size={15} /> Save</button>;

  return (
    <div>
      <PageHead title="Workflow & System Settings" icon="Workflow" subtitle="Configure process sequence, responsibility, approvals, required documents, closure conditions, numbering, tolerances and alerts." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'workflow', label: 'Workflow engine' }, { key: 'numbering', label: 'Units & job numbering' }, { key: 'tolerance', label: 'Tolerances' }, { key: 'notifications', label: 'Notification rules' }, { key: 'company', label: 'Company' }]} />

      {tab === 'workflow' && (
        <Card title="Process sequence" icon="Workflow" actions={<SaveBtn k="workflow" />} pad={false}>
          <div className="card-body muted small">The next process is calculated automatically from previous process status. Stages marked "Closure" must be complete before a job is READY TO CLOSE. Disabled stages are treated as not applicable.</div>
          <div className="table-wrap">
            <table className="tbl tbl-mini">
              <thead><tr><th>#</th><th>Stage</th><th>Enabled</th><th>Responsible dept</th><th>Responsible user</th><th>Approval</th><th>Closure</th><th>Required documents</th><th>Completion condition / notes</th>{!ro && <th />}</tr></thead>
              <tbody>{wf.map((w, i) => (
                <tr key={w.key}>
                  <td>{i + 1}</td>
                  <td><b>{w.label}</b><div className="muted small mono">{w.key}</div></td>
                  <td><input type="checkbox" disabled={ro} checked={w.enabled !== false} onChange={(e) => setWf(i, { enabled: e.target.checked })} /></td>
                  <td><select disabled={ro} value={w.department} onChange={(e) => setWf(i, { department: e.target.value })} style={{ minWidth: 170 }}>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></td>
                  <td><select disabled={ro} value={w.responsibleUser || ''} onChange={(e) => setWf(i, { responsibleUser: e.target.value })} style={{ minWidth: 150 }}><option value="">—</option>{users.map((u) => <option key={u._id} value={u.label}>{u.label}</option>)}</select></td>
                  <td><input type="checkbox" disabled={ro} checked={!!w.approvalRequired} onChange={(e) => setWf(i, { approvalRequired: e.target.checked })} /></td>
                  <td><input type="checkbox" disabled={ro} checked={!!w.requiredForClosure} onChange={(e) => setWf(i, { requiredForClosure: e.target.checked })} /></td>
                  <td style={{ minWidth: 200 }}>
                    <div className="row-wrap" style={{ gap: 4 }}>{(w.requiredDocuments || []).map((d) => <span key={d} className="chip">{d}{!ro && <Icon name="X" size={11} style={{ cursor: 'pointer' }} onClick={() => setWf(i, { requiredDocuments: w.requiredDocuments.filter((x) => x !== d) })} />}</span>)}</div>
                    {!ro && <select value="" onChange={(e) => e.target.value && setWf(i, { requiredDocuments: [...new Set([...(w.requiredDocuments || []), e.target.value])] })} style={{ height: 28, marginTop: 4 }}><option value="">+ document</option>{DOCUMENT_TYPES.map((d) => <option key={d}>{d}</option>)}</select>}
                  </td>
                  <td><input disabled={ro} value={w.completionCondition || ''} onChange={(e) => setWf(i, { completionCondition: e.target.value })} placeholder="e.g. PP sample approved" style={{ minWidth: 180 }} /></td>
                  {!ro && <td className="nowrap"><button className="btn btn-sm btn-ghost btn-icon" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="ArrowUp" size={13} /></button><button className="btn btn-sm btn-ghost btn-icon" disabled={i === wf.length - 1} onClick={() => move(i, 1)}><Icon name="ArrowDown" size={13} /></button></td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'numbering' && (
        <Card title="Units & job number series" icon="Factory">
          <UnitSeries ro={ro} subJob={s.subJob} />
          <div className="form-grid mt">
            <Field label="Sub job prefix"><input disabled={ro} value={s.subJob.prefix} onChange={(e) => setObj('subJob', 'prefix', e.target.value.toUpperCase())} /></Field>
            <Field label="Sub job digits"><input disabled={ro} type="number" value={s.subJob.digits} onChange={(e) => setObj('subJob', 'digits', Number(e.target.value))} /></Field>
            <Field label=" ">{!ro && <button className="btn" onClick={() => save('subJob')}>Save sub job rule</button>}</Field>
          </div>
        </Card>
      )}

      {tab === 'tolerance' && (
        <Card title="Quantity tolerances" icon="Percent" actions={<SaveBtn k="tolerance" />}>
          <div className="form-grid">
            <Field label="Short-ship tolerance %" hint="Stage counts as complete when quantity ≥ order × (1 − %)"><input disabled={ro} type="number" value={s.tolerance.shortShipPct} onChange={(e) => setObj('tolerance', 'shortShipPct', Number(e.target.value))} /></Field>
            <Field label="Over-cut allowance %" hint="Cutting above order + % needs override"><input disabled={ro} type="number" value={s.tolerance.overCutPct} onChange={(e) => setObj('tolerance', 'overCutPct', Number(e.target.value))} /></Field>
            <Field label="Over-ship allowance %" hint="Shipment above order + % needs Admin override"><input disabled={ro} type="number" value={s.tolerance.overShipPct} onChange={(e) => setObj('tolerance', 'overShipPct', Number(e.target.value))} /></Field>
          </div>
        </Card>
      )}

      {tab === 'notifications' && (
        <Card title="Notification rules" icon="BellRing" actions={<SaveBtn k="notifications" />}>
          <div className="form-grid">
            {Object.entries(s.notifications).filter(([, v]) => typeof v === 'boolean').map(([k, v]) => (
              <label key={k} className="check"><input type="checkbox" disabled={ro} checked={v} onChange={(e) => setObj('notifications', k, e.target.checked)} /> {k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</label>
            ))}
            <Field label="Payment due warning (days before)"><input disabled={ro} type="number" value={s.notifications.paymentDueDays} onChange={(e) => setObj('notifications', 'paymentDueDays', Number(e.target.value))} /></Field>
          </div>
          <div className="muted small mt"><Badge tone="blue" dot={false}>Role-based</Badge> Alerts are delivered to the responsible departments; Admin sees all. A background scan runs every 30 minutes.</div>
        </Card>
      )}

      {tab === 'company' && (
        <Card title="Company profile (used on PDFs)" icon="Building" actions={<SaveBtn k="company" />}>
          <div className="form-grid">
            {['name', 'address', 'phone', 'email', 'baseCurrency'].map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}><input disabled={ro} value={s.company[k] || ''} onChange={(e) => setObj('company', k, e.target.value)} /></Field>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/** One ERP, two units: each unit has its own job number series (U1-1000…, U2-3000…). */
function UnitSeries({ ro, subJob }) {
  const { toast } = useFeedback();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState({});
  const load = () => api.get('/admin/units').then((r) => { setRows(r.data.rows); setEdit({}); }).catch((e) => toast(errMsg(e), 'err'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <Loading />;
  const set = (code, k, v) => setEdit({ ...edit, [code]: { ...edit[code], [k]: v } });
  const save = async (u) => {
    try { await api.put(`/admin/units/${u.code}`, edit[u.code]); toast(`${u.code} updated`); load(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div>
      <div className="muted small mb">Both units run the same modules, workflow and calculations; their jobs, transactions, users and reports are kept separate. A series can only move forward, so issued Job Nos are never reused.</div>
      <div className="table-wrap">
        <table className="tbl tbl-mini">
          <thead><tr><th>Code</th><th>Unit name</th><th>Series</th><th className="num">Start</th><th>Next Job No</th><th className="num">Jobs</th><th className="num">Open</th><th className="num">Users</th>{!ro && <th />}</tr></thead>
          <tbody>{rows.map((u) => {
            const e = edit[u.code] || {};
            return (
              <tr key={u.code}>
                <td><Badge tone="primary" dot={false}>{u.code}</Badge></td>
                <td><input disabled={ro} value={e.name ?? u.name} onChange={(x) => set(u.code, 'name', x.target.value)} style={{ minWidth: 140 }} /></td>
                <td className="mono">{u.prefix}-####</td>
                <td className="num">{u.start}</td>
                <td><div className="row"><span className="mono muted">{u.prefix}-</span><input disabled={ro} type="number" min={u.nextJobNo} value={e.nextJobNo ?? u.nextJobNo} onChange={(x) => set(u.code, 'nextJobNo', x.target.value)} style={{ width: 110 }} /></div></td>
                <td className="num">{u.jobs}</td><td className="num">{u.openJobs}</td><td className="num">{u.users}</td>
                {!ro && <td><button className="btn btn-sm btn-primary" disabled={!edit[u.code]} onClick={() => save(u)}><Icon name="Save" size={14} /> Save</button></td>}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div className="alert alert-info mt"><Icon name="Hash" size={16} /> Next jobs: {rows.map((u) => <b key={u.code} className="mono" style={{ marginRight: 12 }}>{u.prefix}-{edit[u.code]?.nextJobNo || u.nextJobNo}</b>)} · Forecast sub jobs: <b className="mono">{rows[0].prefix}-{rows[0].nextJobNo}-{subJob.prefix}01</b></div>
    </div>
  );
}
