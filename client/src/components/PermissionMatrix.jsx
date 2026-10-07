/** Module × action permission grid. value: { moduleKey: [actions] } */
export default function PermissionMatrix({ modules, actions, value = {}, onChange, disabled, inherited = {} }) {
  const has = (m, a) => (value[m] || []).includes(a);
  const toggle = (m, a) => {
    const cur = new Set(value[m] || []);
    if (cur.has(a)) cur.delete(a); else cur.add(a);
    const next = { ...value, [m]: [...cur] };
    if (!next[m].length) delete next[m];
    onChange(next);
  };
  const toggleRow = (m) => onChange({ ...value, [m]: (value[m] || []).length === actions.length ? [] : [...actions] });
  const toggleCol = (a) => {
    const all = modules.every((m) => has(m.key, a));
    const next = { ...value };
    modules.forEach((m) => {
      const s = new Set(next[m.key] || []);
      if (all) s.delete(a); else s.add(a);
      next[m.key] = [...s];
    });
    onChange(next);
  };
  return (
    <div className="table-wrap" style={{ maxHeight: '60vh' }}>
      <table className="tbl tbl-mini perm-matrix">
        <thead>
          <tr>
            <th>Module</th>
            {actions.map((a) => <th key={a} style={{ cursor: disabled ? 'default' : 'pointer' }} onClick={() => !disabled && toggleCol(a)}>{a}</th>)}
          </tr>
        </thead>
        <tbody>
          {modules.map((m) => (
            <tr key={m.key}>
              <td style={{ cursor: disabled ? 'default' : 'pointer' }} onClick={() => !disabled && toggleRow(m.key)}>
                <b>{m.title}</b>{m.group && <div className="muted small">{m.group}</div>}
              </td>
              {actions.map((a) => (
                <td key={a} title={(inherited[m.key] || []).includes(a) ? 'Granted by role' : ''}>
                  <input type="checkbox" disabled={disabled} checked={has(m.key, a)} onChange={() => toggle(m.key, a)}
                    style={(inherited[m.key] || []).includes(a) && !has(m.key, a) ? { outline: '2px solid var(--green-50)' } : undefined} />
                  {(inherited[m.key] || []).includes(a) && <span style={{ color: 'var(--green)', fontSize: 10, marginLeft: 2 }}>●</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
