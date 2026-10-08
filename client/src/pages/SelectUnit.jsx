/** Step 2 of the login: choose the business unit to work in (also used by "Switch Unit"). */
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { errMsg } from '../api.js';
import { Icon, Spinner } from '../components/ui.jsx';

export default function SelectUnit() {
  const { user, selectUnit, logout } = useAuth();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const pick = async (code) => {
    setErr(''); setBusy(code);
    try { await selectUnit(code); } catch (x) { setErr(errMsg(x)); setBusy(''); }
  };

  const units = Array.isArray(user?.units) ? user.units : null;

  return (
    <div className="login-wrap">
      <div className="login-form" style={{ gridColumn: '1 / -1' }}>
        <div className="login-card" style={{ width: 'min(520px, 100%)' }}>
          <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
            <div className="brand-logo"><Icon name="Shirt" size={20} color="#fff" /></div>
            <div><b>StitchFlow ERP</b><small>Signed in as {user?.name}</small></div>
          </div>
          {units ? <UnitList units={units} busy={busy} pick={pick} err={err} logout={logout} /> : <OutdatedServer logout={logout} />}
        </div>
      </div>
    </div>
  );
}

function UnitList({ units, busy, pick, err, logout }) {
  return (
    <>
          <h2>Select Unit</h2>
          <p className="muted" style={{ margin: '6px 0 20px' }}>Choose the unit to work in. All dashboards, jobs, transactions and reports will show that unit's data only.</p>
          <div className="col">
            {units.map((u) => (
              <button key={u.code} className="unit-choice" onClick={() => pick(u.code)} disabled={!!busy}>
                <div className="unit-badge">{u.code}</div>
                <div className="grow" style={{ textAlign: 'left' }}>
                  <b>{u.name.toUpperCase()}</b>
                  <div className="muted small">Job numbers {u.prefix}-…</div>
                </div>
                {busy === u.code ? <Spinner /> : <Icon name="ChevronRight" size={18} />}
              </button>
            ))}
            {err && <div className="alert alert-red"><Icon name="AlertCircle" size={16} /> {err}</div>}
            {!units.length && <div className="alert alert-warn"><Icon name="Info" size={16} /> No unit is assigned to your account – contact Admin.</div>}
            <button className="btn btn-ghost" onClick={logout}><Icon name="LogOut" size={15} /> Sign out</button>
          </div>
    </>
  );
}

/** The API server is a version from before Unit-1 / Unit-2 existed (it sends no unit list). */
function OutdatedServer({ logout }) {
  return (
    <div className="col">
      <h2>Server update needed</h2>
      <div className="alert alert-warn"><Icon name="ServerCog" size={16} /> The API server you are connected to is an older version without Unit-1 / Unit-2 support. Start the latest API locally or deploy the latest backend, then sign in again.</div>
      <button className="btn btn-ghost" onClick={logout}><Icon name="LogOut" size={15} /> Sign out</button>
    </div>
  );
}
