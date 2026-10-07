/** Chart helpers – colors come from theme tokens (validated categorical order, never cycled). */
import { useEffect, useState } from 'react';
import { ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { fmtNum } from '../utils/format.js';

const readVars = () => {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g(`--series-${i}`)),
    grid: g('--chart-grid'), muted: g('--muted'), text: g('--text'), surface: g('--surface'),
    green: g('--green'), amber: g('--amber'), red: g('--red'), grey: g('--grey'),
  };
};

/** Re-reads tokens when the theme toggles */
export function useChartTheme() {
  const [t, setT] = useState(readVars);
  useEffect(() => {
    const obs = new MutationObserver(() => setT(readVars()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return t;
}

export function ChartBox({ height = 260, children }) {
  return <div style={{ width: '100%', height }}><ResponsiveContainer>{children}</ResponsiveContainer></div>;
}

export function ChartTooltip({ format = (v) => fmtNum(v) }) {
  return (
    <Tooltip
      cursor={{ fill: 'var(--surface-3)', opacity: 0.5 }}
      contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }}
      labelStyle={{ fontWeight: 650, color: 'var(--text)' }}
      formatter={(v, n) => [format(v), n]}
    />
  );
}

export const ChartLegend = () => <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--text-2)' }} />;
