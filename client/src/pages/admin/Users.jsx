/** User management – department, role, credentials and per-user permission grants / revokes. */
import { useEffect, useState } from 'react';
import { api, errMsg } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useFeedback } from '../../components/Feedback.jsx';
import { PageHead, Icon, Card, Drawer, Field, Badge, StatusBadge, Tabs, Empty } from '../../components/ui.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import PermissionMatrix from '../../components/PermissionMatrix.jsx';
import { DEPARTMENTS } from '@shared/constants.js';
import { fmtDateTime } from '../../utils/format.js';
import { useUnitName } from '../../components/UnitScope.jsx';

const blank = { name: '', email: '', password: '', role: '', department: '', phone: '', units: [], isActive: true, permissions: {}, revoked: {} };

export default function Users() {
  const { can, user: me } = useAuth();
  const { toast, askReason, confirm } = useFeedback();
  const [rows, setRows] = useState([]);
  const [roles, setRoles] = useState({ rows: [], modules: [], actions: [] });
  const [q, setQ] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [edit, setEdit] = useState(null);
  const [tab, setTab] = useState('profile');
  const [loading, setLoading] = useState(true);
  const [unitFilter, setUnitFilter] = useState('');
  const unitName = useUnitName();

  const load = () => {
    setLoading(true);
    api.get('/admin/users', { params: { q: q || undefined, deleted: deleted ? 'true' : undefined, unit: unitFilter || undefined } }).then((r) => setRows(r.data.rows)).catch((e) => toast(errMsg(e), 'err')).finally(() => setLoading(false));
  };
  useEffect(load, [q, deleted, unitFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/admin/roles').then((r) => setRoles(r.data)).catch(() => {}); }, []);

  const roleOf = (id) => roles.rows.find((r) => r._id === id);
  const open = (u) => {
    setTab('profile');
    setEdit(u ? { ...blank, ...u, units: u.units || [], role: u.role?._id || u.role, password: '' } : { ...blank, units: [me.unit.code], role: roles.rows.find((r) => !r.isAdmin)?._id || '' });
  };

  const save = async () => {
    try {
      if (edit._id) await api.put(`/admin/users/${edit._id}`, edit);
      else await api.post('/admin/users', edit);
      toast(edit._id ? 'User updated' : 'User created – they must change the password at first login');
      setEdit(null); load();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const resetPw = async () => {
    const pw = await askReason('Enter a temporary password (min 8 chars, upper, lower, number, symbol). The user must change it at next login.', { title: 'Reset password', label: 'Temporary password', confirmLabel: 'Reset' });
    if (!pw) return;
    try { await api.post(`/admin/users/${edit._id}/reset-password`, { password: pw }); toast('Password reset'); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const remove = async () => {
    if (!(await confirm(`Delete user ${edit.email}? Sessions are revoked; Admin can restore.`, { danger: true }))) return;
    try { await api.delete(`/admin/users/${edit._id}`); toast('User deleted'); setEdit(null); load(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const restore = async (u) => { try { await api.post(`/admin/users/${u._id}/restore`); toast('Restored'); load(); } catch (e) { toast(errMsg(e), 'err'); } };

  const columns = [
    { key: 'name', label: 'User', render: (u) => <div className="row"><div className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{u.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}</div><div><b>{u.name}</b><div className="muted small">{u.email}</div></div></div> },
    { key: 'department', label: 'Department' },
    { key: 'role', label: 'Role', render: (u) => <Badge tone={u.role?.isAdmin ? 'violet' : 'primary'} dot={false}>{u.role?.name}</Badge> },
    { key: 'units', label: 'Units', render: (u) => (u.role?.isAdmin ? <Badge tone="violet" dot={false}>All units</Badge> : <div className="row-wrap" style={{ gap: 4 }}>{(u.units || []).map((x) => <Badge key={x} tone="blue" dot={false}>{unitName(x)}</Badge>)}</div>) },
    { key: 'extra', label: 'Custom perms', render: (u) => (Object.keys(u.permissions || {}).length || Object.keys(u.revoked || {}).length ? <Badge tone="amber">customised</Badge> : <span className="muted">role</span>) },
    { key: 'lastLoginAt', label: 'Last login', render: (u) => <span className="small">{fmtDateTime(u.lastLoginAt)}</span> },
    { key: 'isActive', label: 'Status', render: (u) => (u.isDeleted ? <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); restore(u); }}>Restore</button> : <div className="row"><StatusBadge status={u.isActive ? 'Active' : 'Inactive'} />{u.mustChangePassword && <Badge tone="amber" dot={false}>pw change</Badge>}</div>) },
  ];

  const role = edit && roleOf(edit.role);
  return (
    <div>
      <PageHead title="Users" icon="UserCog" subtitle="Create users, assign department and role, and fine-tune exactly which permissions each user gets.">
        {can('users', 'create') && <button className="btn btn-primary" onClick={() => open(null)}><Icon name="UserPlus" size={16} /> New user</button>}
      </PageHead>
      <Card pad={false}>
        <div className="table-toolbar">
          <div className="search"><Icon name="Search" size={15} /><input className="search-input" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {me.isAdmin && <select value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)} style={{ width: 'auto' }}><option value="">All units</option>{me.units.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}</select>}
          {me.isAdmin && <label className="check small"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Deleted</label>}
        </div>
        <DataTable columns={columns} rows={rows} loading={loading} onRowClick={(u) => !u.isDeleted && open(u)} empty={<Empty icon="Users" title="No users" />} />
      </Card>

      {edit && (
        <Drawer title={edit._id ? edit.name : 'New user'} subtitle={edit.email} onClose={() => setEdit(null)}
          footer={<>
            {edit._id && can('users', 'delete') && edit._id !== me._id && <button className="btn btn-danger" onClick={remove}><Icon name="Trash2" size={15} /> Delete</button>}
            {edit._id && can('users', 'edit') && <button className="btn" onClick={resetPw}><Icon name="KeyRound" size={15} /> Reset password</button>}
            <div className="grow" />
            <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}><Icon name="Save" size={15} /> Save</button>
          </>}>
          <Tabs value={tab} onChange={setTab} tabs={[{ key: 'profile', label: 'Profile & role' }, ...(me.isAdmin ? [{ key: 'grant', label: 'Extra permissions' }, { key: 'revoke', label: 'Revoked permissions' }] : [])]} />
          {tab === 'profile' && (
            <div className="card card-pad">
              <div className="form-grid">
                <Field label="Full name" required><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
                <Field label="Email / username" required><input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
                {!edit._id && <Field label="Initial password" required hint="8+ chars, upper, lower, number, symbol. User must change at first login."><input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>}
                <Field label="Role" required>
                  <select value={edit.role} onChange={(e) => { const r = roleOf(e.target.value); setEdit({ ...edit, role: e.target.value, department: edit.department || r?.department || '' }); }}>
                    {roles.rows.filter((r) => me.isAdmin || !r.isAdmin).map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}
                  </select>
                </Field>
                <Field label="Department"><select value={edit.department || ''} onChange={(e) => setEdit({ ...edit, department: e.target.value })}><option value="">—</option>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></Field>
                <Field label="Phone"><input value={edit.phone || ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
                <Field label="Units" required={!role?.isAdmin} hint={role?.isAdmin ? 'Admin role reaches every unit' : 'The user can only select and see these units'}>
                  <div className="row-wrap" style={{ minHeight: 38 }}>
                    {me.units.map((u) => (
                      <label key={u.code} className="check"><input type="checkbox" disabled={role?.isAdmin} checked={role?.isAdmin || (edit.units || []).includes(u.code)}
                        onChange={(e) => setEdit({ ...edit, units: e.target.checked ? [...new Set([...(edit.units || []), u.code])] : (edit.units || []).filter((x) => x !== u.code) })} /> {u.name}</label>
                    ))}
                  </div>
                </Field>
                {edit._id && <Field label=" "><label className="check"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Account active</label></Field>}
              </div>
              {role && <div className="alert alert-info mt"><Icon name="Info" size={16} /> {role.isAdmin ? 'Admin role has complete access to everything.' : `Role "${role.name}" grants ${Object.keys(role.permissions || {}).length} modules. Use the other tabs to add or remove individual permissions for this user.`}</div>}
            </div>
          )}
          {tab === 'grant' && (
            <div className="card">
              <div className="card-body muted small">Ticked = granted in addition to the role. ● = already granted by role.</div>
              <PermissionMatrix modules={roles.modules} actions={roles.actions} value={edit.permissions || {}} inherited={role?.permissions || {}} onChange={(v) => setEdit({ ...edit, permissions: v })} />
            </div>
          )}
          {tab === 'revoke' && (
            <div className="card">
              <div className="card-body muted small">Ticked = removed from this user even though the role grants it.</div>
              <PermissionMatrix modules={roles.modules} actions={roles.actions} value={edit.revoked || {}} inherited={role?.permissions || {}} onChange={(v) => setEdit({ ...edit, revoked: v })} />
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}
