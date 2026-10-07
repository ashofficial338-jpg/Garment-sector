/** Department Responsibility Framework */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FRAMEWORK } from '@shared/framework.js';
import { MODULES } from '@shared/modules/index.js';
import { PageHead, Icon, Card } from '../components/ui.jsx';

const BLOCKS = [
  ['daily', 'Daily activities', 'CalendarCheck'], ['documents', 'Documents handled', 'FileText'], ['reports', 'Reports generated', 'FileBarChart'],
  ['kpis', 'KPIs measured', 'Gauge'], ['coordination', 'Coordinates with', 'Network'], ['problems', 'Common problems', 'AlertTriangle'], ['solutions', 'Problem-solving method', 'Lightbulb'],
];

export default function Framework() {
  const [sel, setSel] = useState(FRAMEWORK[0].department);
  const fw = FRAMEWORK.find((f) => f.department === sel);
  return (
    <div>
      <PageHead title="Department Responsibility Framework" icon="BookOpenCheck" subtitle="Role, responsibility, daily activities, documents, reports, KPIs, coordination and problem solving – for every department and process." />
      <div className="seg mb" style={{ flexWrap: 'wrap' }}>
        {FRAMEWORK.map((f) => <button key={f.department} className={sel === f.department ? 'on' : ''} onClick={() => setSel(f.department)}>{f.department}</button>)}
      </div>
      <div className="hero rise" key={sel}>
        <h1>{fw.department}</h1>
        <p><b style={{ color: '#fff' }}>{fw.role}</b> — {fw.responsibility}</p>
        <div className="row-wrap mt">{fw.modules.map((m) => MODULES[m] && <Link key={m} to={`/m/${m}`} className="chip" style={{ background: 'rgba(255,255,255,.12)', color: '#fff' }}>{MODULES[m].title}</Link>)}</div>
      </div>
      <div className="fw-grid mt">
        {BLOCKS.map(([k, label, icon]) => (
          <Card key={k} title={label} icon={icon}>
            <ul className="fw-list">{fw[k].map((x) => <li key={x}>{x}</li>)}</ul>
          </Card>
        ))}
      </div>
      <Card className="mt" title="Problem → action matrix" icon="Wrench" pad={false}>
        <table className="tbl">
          <thead><tr><th>Common problem</th><th>Problem-solving method</th></tr></thead>
          <tbody>{fw.problems.map((p, i) => <tr key={p}><td><Icon name="AlertTriangle" size={14} style={{ color: 'var(--amber)', verticalAlign: -2 }} /> {p}</td><td>{fw.solutions[i] || '—'}</td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}
