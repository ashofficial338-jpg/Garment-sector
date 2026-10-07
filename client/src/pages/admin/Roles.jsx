/** Roles & permission matrix (View, Create, Edit, Delete, Approve, Export, Close, Override, Reports). */
import { useEffect, useState } from 'react';
import { api, errMsg } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useFeedback } from '../../components/Feedback.jsx';
import { PageHead, Icon, Card, Field, Badge, Empty } from '../../components/ui.jsx';
import PermissionMatrix from '../../components/PermissionMatrix.jsx';
import { DEPARTMENTS } from '@shared/constants.js';
import { DASHBOARDS } from '../Dashboard.jsx';

export default function Roles() {
  const { user } = useAuth();
  const { toast, confirm } = useFeedback();
  const [data, setData] = useState({ rows: [], modules: [], actions: [] });
  const [sel, setSel] = useState(null);
  const [draft, setDraft] = useState(null);

  const load = (keep) => api.get('/admin/roles').then((r) => {
    setData(r.data);
    const pick = r.data.rows.find((x) => x._id === (keep || sel)) || r.data.rows[0];
    if (pick) { setSel(pick._id); setDraft({ ...pick, permissions: { ...(pick.permissions || {}) } }); }
  }).catch((e) => toast(errMsg(e), 'err'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (r) => { setSel(r._id); setDraft({ ...r, permissions: { ...(r.permissions || {}) } }); };
  const save = async () => {
    try {
      if (draft._id) await api.put(`/admin/roles/${draft._id}`, draft);
      else { const { data: d } = await api.post('/admin/roles', draft); setSel(d._id); }
      toast('Role saved'); load(draft._id);
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const remove = async () => {
    if (!(await confirm(`Delete role "${draft.name}"?`, { danger: true }))) return;
    try { await api.delete(`/admin/roles/${draft._id}`); toast('Role deleted'); setSel(null); load(); } catch (e) { toast(errMsg(e), 'err'); }
  };

  return (
    <div>
      <PageHead title="Roles & Permissions" icon="KeyRound" subtitle="Admin decides exactly which department role gets which permission. The API enforces every permission independently of the UI.">
        {user.isAdmin && <button className="btn btn-primary" onClick={() => { setSel(null); setDraft({ name: '', department: '', description: '', permissions: { dashboard: ['view'] }, dashboard: 'admin' }); }}><Icon name="Plus" size={16} /> New role</button>}
      </PageHead>
      <div className="grid side-grid">
        <Card title="Roles" icon="Users" pad={false}>
          {data.rows.map((r) => (
            <div key={r._id} className={`search-item ${sel === r._id ? 'on' : ''}`} onClick={() => choose(r)} style={{ margin: 6 }}>
              <Icon name={r.isAdmin ? 'Crown' : 'Shield'} size={16} />
              <div className="grow"><div className="t">{r.name}</div><div className="s">{r.users} user(s)</div></div>
              {r.isSystem && <Badge tone="violet" dot={false}>system</Badge>}
            </div>
          ))}
        </Card>
        {draft ? (
          <Card title={draft._id ? draft.name : 'New role'} icon="ShieldCheck" actions={user.isAdmin && !draft.isAdmin && <>
            {draft._id && !draft.isSystem && <button className="btn btn-sm btn-danger" onClick={remove}><Icon name="Trash2" size={14} /></button>}
            <button className="btn btn-sm btn-primary" onClick={save}><Icon name="Save" size={14} /> Save</button></>}>
            {draft.isAdmin ? <div className="alert alert-ok"><Icon name="Crown" size={16} /> Admin has complete access: view, create, edit, delete, restore, approve, override and close everything.</div> : (
              <>
                <div className="form-grid mb">
                  <Field label="Role name"><input value={draft.name} disabled={!user.isAdmin} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                  <Field label="Department"><select value={draft.department || ''} disabled={!user.isAdmin} onChange={(e) => setDraft({ ...draft, department: e.target.value })}><option value="">—</option>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></Field>
                  <Field label="Landing dashboard"><select value={draft.dashboard || ''} disabled={!user.isAdmin} onChange={(e) => setDraft({ ...draft, dashboard: e.target.value })}>{Object.entries(DASHBOARDS).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}</select></Field>
                  <Field label="Description" span><input value={draft.description || ''} disabled={!user.isAdmin} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
                </div>
                <div className="muted small mb">Click a module name to toggle the whole row, or an action header to toggle the whole column.</div>
                <PermissionMatrix modules={data.modules} actions={data.actions} value={draft.permissions} disabled={!user.isAdmin} onChange={(v) => setDraft({ ...draft, permissions: v })} />
              </>
            )}
          </Card>
        ) : <Empty title="Select a role" />}
      </div>
    </div>
  );
}
