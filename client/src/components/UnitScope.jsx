/**
 * Unit scope picker for read-only views (reports, dashboard, audit):
 * current unit (default), another assigned unit, or both units consolidated.
 * Hidden for users who can only reach one unit.
 */
import { useAuth } from '../auth/AuthContext.jsx';

export function UnitScope({ value, onChange, style }) {
  const { user } = useAuth();
  if ((user.units || []).length < 2) return null;
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} style={style} aria-label="Unit">
      <option value="">{user.unit.name} (current)</option>
      {user.units.filter((u) => u.code !== user.unit.code).map((u) => <option key={u.code} value={u.code}>{u.name} only</option>)}
      <option value="ALL">Both units – consolidated</option>
    </select>
  );
}

/** Label for a unit code (falls back to the code). */
export function useUnitName() {
  const { user } = useAuth();
  return (code) => user.units?.find((u) => u.code === code)?.name || code || '';
}
