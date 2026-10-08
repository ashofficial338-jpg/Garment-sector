import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { errMsg } from '../api.js';
import { Field, Icon, Spinner } from '../components/ui.jsx';

const FLOW = ['Enquiry', 'Costing', 'Quotation', 'Order', 'Spec', 'BOM', 'CAD', 'Pattern', 'Grading', 'Marker', 'T&A', 'PP Meeting', 'Fabric', 'Trims', 'Sampling', 'Planning', 'Cutting', 'Sewing', 'Finishing', 'Packing', 'Inspection', 'Shipment', 'Documents', 'Accounts', 'Payment', 'Profit', 'Job Close'];

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await login(email, password); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-logo"><Icon name="Shirt" size={20} color="#fff" /></div>
          <div><b>StitchFlow ERP</b><small>Garment Order → Shipment</small></div>
        </div>
        <div>
          <h1>One Job. One connected data flow. Complete traceability.</h1>
          <p>From buyer enquiry to payment and profit analysis – every department works on the same Job Number, with automatic calculations, controlled approvals and audit-ready history.</p>
          <div className="login-flow" style={{ marginTop: 24 }}>{FLOW.map((f) => <span key={f}>{f}</span>)}</div>
        </div>
        <svg viewBox="0 0 600 120" style={{ opacity: 0.25 }} aria-hidden="true">
          <path d="M0 60 Q 75 10 150 60 T 300 60 T 450 60 T 600 60" stroke="#a5b4fc" strokeWidth="2" fill="none" strokeDasharray="8 8" />
          {[0, 150, 300, 450, 600].map((x) => <circle key={x} cx={x} cy="60" r="6" fill="#5eead4" />)}
        </svg>
      </div>
      <div className="login-form">
        <form className="login-card" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="muted" style={{ margin: '6px 0 22px' }}>Use the account issued by your administrator. You choose your unit next.</p>
          <div className="col">
            <Field label="Email / Username"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
            <Field label="Password">
              <div style={{ position: 'relative' }}>
                <input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" className="btn btn-ghost btn-icon btn-sm" style={{ position: 'absolute', right: 3, top: 3 }} onClick={() => setShow(!show)} aria-label="Show password"><Icon name={show ? 'EyeOff' : 'Eye'} size={15} /></button>
              </div>
            </Field>
            {err && <div className="alert alert-red"><Icon name="AlertCircle" size={16} /> {err}</div>}
            <button className="btn btn-primary" style={{ height: 42 }} disabled={busy}>{busy ? <Spinner /> : <Icon name="LogIn" size={16} />} Sign in</button>
            <div className="muted small row"><Icon name="ShieldCheck" size={14} /> Secured with hashed passwords, short-lived tokens and audit logging.</div>
          </div>
        </form>
      </div>
    </div>
  );
}
