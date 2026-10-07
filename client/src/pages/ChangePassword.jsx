import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { errMsg } from '../api.js';
import { Field, Icon, Spinner } from '../components/ui.jsx';
import { useFeedback } from '../components/Feedback.jsx';

const RULES = [
  ['At least 8 characters', (p) => p.length >= 8],
  ['Upper & lower case letters', (p) => /[a-z]/.test(p) && /[A-Z]/.test(p)],
  ['A number', (p) => /\d/.test(p)],
  ['A symbol', (p) => /[^A-Za-z0-9]/.test(p)],
];

export default function ChangePassword() {
  const { user, changePassword, logout } = useAuth();
  const { toast } = useFeedback();
  const nav = useNavigate();
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const forced = user?.mustChangePassword;
  const valid = RULES.every(([, fn]) => fn(p1)) && p1 === p2;

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await changePassword(cur, p1); toast('Password updated'); nav('/'); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  return (
    <div className="login-form" style={{ minHeight: forced ? '100vh' : 'auto', background: forced ? 'var(--bg)' : undefined }}>
      <form className="card card-pad login-card" onSubmit={submit} style={{ width: 'min(440px, 100%)' }}>
        <h2 className="row"><Icon name="KeyRound" /> {forced ? 'Set a new password' : 'Change password'}</h2>
        {forced && <div className="alert alert-warn mt"><Icon name="ShieldAlert" size={16} /> For security, you must change the initial password before using the system.</div>}
        <div className="col mt">
          <Field label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
          <Field label="New password"><input type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} required /></Field>
          <Field label="Confirm new password" error={p2 && p1 !== p2 ? 'Passwords do not match' : ''}><input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} required /></Field>
          <div className="row-wrap">{RULES.map(([l, fn]) => <span key={l} className={`badge ${fn(p1) ? 'b-green' : 'b-grey'}`}>{l}</span>)}</div>
          {err && <div className="alert alert-red">{err}</div>}
          <button className="btn btn-primary" disabled={!valid || busy}>{busy ? <Spinner /> : <Icon name="Check" size={16} />} Update password</button>
          {forced && <button type="button" className="btn btn-ghost" onClick={logout}>Sign out</button>}
        </div>
      </form>
    </div>
  );
}
