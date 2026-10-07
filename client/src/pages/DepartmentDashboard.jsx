import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import Dashboard, { DASHBOARDS } from './Dashboard.jsx';

/** Department-specific dashboard (defaults to the user's role dashboard; Admin can switch). */
export default function DepartmentDashboard() {
  const { user } = useAuth();
  const [focus, setFocus] = useState(user.role?.dashboard && DASHBOARDS[user.role.dashboard] ? user.role.dashboard : 'admin');
  return (
    <div>
      {user.isAdmin && (
        <div className="seg mb" style={{ flexWrap: 'wrap' }}>
          {Object.entries(DASHBOARDS).map(([k, v]) => <button key={k} className={focus === k ? 'on' : ''} onClick={() => setFocus(k)}>{v.title}</button>)}
        </div>
      )}
      <Dashboard key={focus} focus={focus} />
    </div>
  );
}
