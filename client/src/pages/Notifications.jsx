import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHead, Icon, Card, Empty, Badge } from '../components/ui.jsx';
import { fmtDateTime } from '../utils/format.js';

const TYPES = ['TNA_DELAY', 'FABRIC_SHORTAGE', 'TRIM_SHORTAGE', 'APPROVAL_PENDING', 'PRODUCTION_DELAY', 'QUALITY_FAIL', 'SHIPMENT_DELAY', 'PAYMENT_DUE', 'JOB_READY_TO_CLOSE', 'FABRIC_READY_TO_CLOSE', 'INFO'];
const TONE = { info: 'blue', success: 'green', warning: 'amber', danger: 'red' };

export default function Notifications() {
  const [rows, setRows] = useState([]);
  const [type, setType] = useState('');
  const [unread, setUnread] = useState(false);
  const nav = useNavigate();
  const load = () => api.get('/notifications', { params: { limit: 200, type: type || undefined, unread: unread ? 'true' : undefined } }).then((r) => setRows(r.data.rows));
  useEffect(() => { load(); }, [type, unread]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <PageHead title="Notifications" icon="Bell" subtitle="Role-based alerts for delays, shortages, approvals, quality, shipments, payments and closures.">
        <button className="btn" onClick={async () => { await api.post('/notifications/read-all'); load(); }}><Icon name="CheckCheck" size={15} /> Mark all read</button>
      </PageHead>
      <Card pad={false}>
        <div className="table-toolbar">
          <select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
          <label className="check small"><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /> Unread only</label>
        </div>
        {!rows.length && <Empty icon="BellOff" title="No notifications" />}
        {rows.map((n) => (
          <div key={n._id} className={`notif ${n.read ? '' : 'unread'}`} onClick={async () => { await api.post(`/notifications/${n._id}/read`); if (n.link) nav(n.link); else if (n.jobNo) nav(`/jobs/${n.jobNo}`); else load(); }}>
            <Badge tone={TONE[n.severity] || 'blue'} dot={false}>{(n.type || 'INFO').replace(/_/g, ' ')}</Badge>
            <div className="grow"><b>{n.title}</b><div className="muted small">{n.message}</div></div>
            <div className="muted small nowrap">{fmtDateTime(n.createdAt)}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}
