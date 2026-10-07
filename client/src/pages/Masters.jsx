/** Master data (generic typed masters) – grouped by master type. */
import { useSearchParams } from 'react-router-dom';
import { MASTER_TYPES } from '@shared/modules/masters.js';
import ModulePage from './ModulePage.jsx';

export default function Masters() {
  const [sp, setSp] = useSearchParams();
  const type = sp.get('type') || '';
  return (
    <div>
      <div className="seg mb" style={{ flexWrap: 'wrap' }}>
        <button className={!type ? 'on' : ''} onClick={() => setSp({})}>All</button>
        {MASTER_TYPES.map((t) => <button key={t} className={type === t ? 'on' : ''} onClick={() => setSp({ type: t, f_masterType: t })}>{t}</button>)}
      </div>
      <ModulePage key={type} moduleKey="master" />
    </div>
  );
}
