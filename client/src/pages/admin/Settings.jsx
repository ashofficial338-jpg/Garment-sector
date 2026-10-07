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
  const jn = s.jobNumber;
  const preview = [jn.prefix, jn.includeYear ? new Date().getFullYear() : null, '1'.padStart(jn.digits, '0')].filter(Boolean).join(jn.separator);

  return (
    <div>
      <PageHead title="Workflow & System Settings" icon="Workflow" subtitle="Configure process sequence, responsibility, approvals, required documents, closure conditions, numbering, tolerances and alerts." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'workflow', label: 'Workflow engine' }, { key: 'numbering', label: 'Job numbering' }, { key: 'tolerance', label: 'Tolerances' }, { key: 'notifications', label: 'Notification rules' }, { key: 'company', label: 'Company' }]} />

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
        <Card title="Job number format" icon="Hash" actions={<SaveBtn k="jobNumber" />}>
          <div className="form-grid">
            <Field label="Prefix"><input disabled={ro} value={jn.prefix} onChange={(e) => setObj('jobNumber', 'prefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></Field>
            <Field label="Digits"><input disabled={ro} type="number" min={3} max={8} value={jn.digits} onChange={(e) => setObj('jobNumber', 'digits', Number(e.target.value))} /></Field>
            <Field label="Separator"><select disabled={ro} value={jn.separator} onChange={(e) => setObj('jobNumber', 'separator', e.target.value)}><option>-</option><option>/</option></select></Field>
            <Field label=" "><label className="check"><input type="checkbox" disabled={ro} checked={jn.includeYear} onChange={(e) => setObj('jobNumber', 'includeYear', e.target.checked)} /> Include year (resets yearly)</label></Field>
          </div>
          <div className="alert alert-info mt"><Icon name="Hash" size={16} /> Next jobs will look like <b className="mono">{preview}</b>. Sub jobs: <b className="mono">{preview}-{s.subJob.prefix}01</b></div>
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
