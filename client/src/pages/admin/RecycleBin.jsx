import { useEffect, useState } from 'react';
import { api, errMsg } from '../../api.js';
import { useFeedback } from '../../components/Feedback.jsx';
import { PageHead, Icon, Card, Empty, Badge } from '../../components/ui.jsx';
import { fmtDateTime } from '../../utils/format.js';

export default function RecycleBin() {
  const { toast } = useFeedback();
  const [rows, setRows] = useState(null);
  const load = () => api.get('/admin/recycle-bin').then((r) => setRows(r.data.rows)).catch((e) => toast(errMsg(e), 'err'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (r) => {
    try { await api.post(r.module === 'orders' ? `/jobs/${r._id}/restore` : `/m/${r.module}/${r._id}/restore`); toast(`${r.refNo} restored`); load(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div>
      <PageHead title="Recycle Bin" icon="Trash2" subtitle="Business records are soft-deleted and remain recoverable by Admin." />
      <Card pad={false}>
        {rows && !rows.length ? <Empty icon="Trash2" title="Recycle bin is empty" /> : (
          <table className="tbl">
            <thead><tr><th>Module</th><th>Reference</th><th>Job</th><th>Description</th><th>Deleted</th><th>Reason</th><th /></tr></thead>
            <tbody>{(rows || []).map((r) => (
              <tr key={`${r.module}-${r._id}`}>
                <td><Badge tone="grey" dot={false}>{r.moduleTitle}</Badge></td><td className="mono">{r.refNo}</td><td className="mono small">{r.jobNo || '—'}</td>
                <td>{r.label}</td><td className="small">{fmtDateTime(r.deletedAt)}</td><td className="small">{r.deleteReason || '—'}</td>
                <td><button className="btn btn-sm" onClick={() => restore(r)}><Icon name="RotateCcw" size={14} /> Restore</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
