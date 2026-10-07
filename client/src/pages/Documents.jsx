/** Buyer documentation & document management (versions, preview, download, delete, restore). */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errMsg, download, openFile } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFeedback } from '../components/Feedback.jsx';
import { PageHead, Icon, Card, Modal, Field, Badge, Empty } from '../components/ui.jsx';
import { RefSelect } from '../components/FormRenderer.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DOCUMENT_TYPES, DEPARTMENTS } from '@shared/constants.js';
import { fmtDateTime } from '../utils/format.js';

export default function Documents() {
  const { can, user } = useAuth();
  const { toast, askReason } = useFeedback();
  const [sp] = useSearchParams();
  const [job, setJob] = useState(sp.get('job') || '');
  const [docType, setDocType] = useState('');
  const [q, setQ] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [data, setData] = useState({ rows: [], total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [upload, setUpload] = useState(null);
  const [versions, setVersions] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/documents', { params: { job: job || undefined, docType: docType || undefined, q: q || undefined, deleted: deleted ? 'true' : undefined, page, limit: 20 } })
      .then((r) => setData(r.data)).catch((e) => toast(errMsg(e), 'err')).finally(() => setLoading(false));
  };
  useEffect(load, [job, docType, q, deleted, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!upload.file) { toast('Choose a file', 'warn'); return; }
    const fd = new FormData();
    Object.entries(upload).forEach(([k, v]) => { if (v && k !== 'file' && k !== 'replace') fd.append(k, v); });
    fd.append('file', upload.file);
    try {
      if (upload.replace) await api.post(`/documents/${upload.replace}/versions`, fd);
      else await api.post('/documents', fd);
      toast(upload.replace ? 'New version uploaded' : 'Document uploaded'); setUpload(null); load();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const remove = async (d) => {
    const reason = await askReason(`Delete "${d.title}"? Admin can restore it.`, { danger: true, confirmLabel: 'Delete' });
    if (reason === null) return;
    try { await api.delete(`/documents/${d._id}`, { data: { reason } }); toast('Deleted'); load(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const restore = async (d) => { try { await api.post(`/documents/${d._id}/restore`); toast('Restored'); load(); } catch (e) { toast(errMsg(e), 'err'); } };

  const columns = [
    { key: 'refNo', label: 'Ref', render: (d) => <span className="mono">{d.refNo}</span> },
    { key: 'jobNo', label: 'Job No', render: (d) => d.jobNo || '—' },
    { key: 'docType', label: 'Type', render: (d) => <Badge tone="primary" dot={false}>{d.docType}</Badge> },
    { key: 'title', label: 'Title' },
    { key: 'department', label: 'Department' },
    { key: 'currentVersion', label: 'Ver', render: (d) => <a style={{ cursor: 'pointer' }} onClick={() => setVersions(d)}>v{d.currentVersion}</a> },
    { key: 'createdByName', label: 'Uploaded by', render: (d) => <div><div>{d.versions[d.versions.length - 1]?.uploadedByName}</div><div className="muted small">{fmtDateTime(d.updatedAt)}</div></div> },
    { key: 'a', label: '', sortable: false, render: (d) => (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-ghost" title="Preview" onClick={() => openFile(`/documents/${d._id}/file`).catch((e) => toast(errMsg(e), 'err'))}><Icon name="Eye" size={15} /></button>
        <button className="btn btn-sm btn-ghost" title="Download" onClick={() => download(`/documents/${d._id}/file`, { download: 1 }).catch((e) => toast(errMsg(e), 'err'))}><Icon name="Download" size={15} /></button>
        {!d.isDeleted && can('documents', 'edit') && <button className="btn btn-sm btn-ghost" title="Replace (new version)" onClick={() => setUpload({ replace: d._id, title: d.title })}><Icon name="Replace" size={15} /></button>}
        {!d.isDeleted && can('documents', 'delete') && <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => remove(d)}><Icon name="Trash2" size={15} /></button>}
        {d.isDeleted && user.isAdmin && <button className="btn btn-sm" onClick={() => restore(d)}><Icon name="RotateCcw" size={14} /> Restore</button>}
      </div>
    ) },
  ];

  return (
    <div>
      <PageHead title="Buyer Documentation" icon="FolderOpen" subtitle="Commercial invoice, packing list, certificates, BL/AWB and every other document – linked to Job No with version history.">
        {can('documents', 'create') && <button className="btn btn-primary" onClick={() => setUpload({ job, docType: 'Commercial Invoice', department: user.department, title: '' })}><Icon name="Upload" size={16} /> Upload document</button>}
      </PageHead>
      <Card pad={false}>
        <div className="table-toolbar">
          <div className="search"><Icon name="Search" size={15} /><input className="search-input" placeholder="Search title / job / ref…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <input placeholder="Job No" value={job} onChange={(e) => setJob(e.target.value)} style={{ width: 170 }} />
          <select value={docType} onChange={(e) => setDocType(e.target.value)}><option value="">All types</option>{DOCUMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          {user.isAdmin && <label className="check small"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Deleted</label>}
        </div>
        <DataTable columns={columns} rows={data.rows} loading={loading} page={page} pages={data.pages} total={data.total} limit={20} onPage={setPage} empty={<Empty icon="FolderOpen" title="No documents" />} />
      </Card>

      {upload && (
        <Modal title={upload.replace ? `Upload new version – ${upload.title}` : 'Upload document'} onClose={() => setUpload(null)}
          footer={<><button className="btn" onClick={() => setUpload(null)}>Cancel</button><button className="btn btn-primary" onClick={submit}><Icon name="Upload" size={15} /> Upload</button></>}>
          <div className="col">
            {!upload.replace && <>
              <Field label="Job No"><RefSelect refModel="Job" value={upload.jobId} onChange={(v) => setUpload({ ...upload, jobId: v, job: v ? upload.job : '' })} onPick={(it) => setUpload({ ...upload, jobId: it._id, job: it.jobNo })} /></Field>
              <Field label="Document type" required><select value={upload.docType} onChange={(e) => setUpload({ ...upload, docType: e.target.value })}>{DOCUMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Title"><input value={upload.title} onChange={(e) => setUpload({ ...upload, title: e.target.value })} /></Field>
              <Field label="Department"><select value={upload.department || ''} onChange={(e) => setUpload({ ...upload, department: e.target.value })}>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></Field>
            </>}
            <Field label="File" hint="PDF, images, Excel, Word, CSV – max 15 MB" required><input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.docx,.doc,.csv,.txt" onChange={(e) => setUpload({ ...upload, file: e.target.files[0] })} /></Field>
            <Field label="Note"><input value={upload.note || ''} onChange={(e) => setUpload({ ...upload, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {versions && (
        <Modal title={`Version history – ${versions.title}`} onClose={() => setVersions(null)} footer={<button className="btn" onClick={() => setVersions(null)}>Close</button>}>
          <table className="tbl tbl-mini">
            <thead><tr><th>Ver</th><th>File</th><th>By</th><th>Date</th><th /></tr></thead>
            <tbody>{versions.versions.slice().reverse().map((v) => (
              <tr key={v.version}><td>v{v.version}</td><td>{v.originalName}{v.note && <div className="muted small">{v.note}</div>}</td><td>{v.uploadedByName}</td><td className="small">{fmtDateTime(v.uploadedAt)}</td>
                <td><button className="btn btn-sm btn-ghost" onClick={() => download(`/documents/${versions._id}/file`, { version: v.version, download: 1 })}><Icon name="Download" size={14} /></button></td></tr>
            ))}</tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
