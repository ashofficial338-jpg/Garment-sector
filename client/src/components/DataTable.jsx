import { Icon, Empty, Spinner } from './ui.jsx';
import { fmtNum } from '../utils/format.js';

/**
 * Generic interactive table.
 * columns: [{ key, label, render(row), num, sortable, width }]
 */
export function DataTable({ columns, rows, loading, sort, onSort, onRowClick, page, pages, total, limit, onPage, onLimit, empty, footer, mini }) {
  const sortKey = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-');
  return (
    <div>
      <div className="table-wrap">
        <table className={`tbl ${mini ? 'tbl-mini' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`${c.num ? 'num' : ''} ${onSort && c.sortable !== false ? 'sortable' : ''}`}
                  style={c.width ? { width: c.width } : undefined}
                  onClick={() => onSort && c.sortable !== false && onSort(sortKey === c.key && !desc ? `-${c.key}` : c.key)}
                >
                  {c.label}
                  {sortKey === c.key && <Icon name={desc ? 'ChevronDown' : 'ChevronUp'} size={12} style={{ verticalAlign: -2, marginLeft: 3 }} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={columns.length}><div className="row" style={{ justifyContent: 'center', padding: 30 }}><Spinner /></div></td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={columns.length}>{empty || <Empty />}</td></tr>
            )}
            {!loading && rows.map((r, i) => (
              <tr key={r._id || i} className={onRowClick ? 'click' : ''} onClick={() => onRowClick?.(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      {onPage && (
        <div className="pager">
          <div>{total ? `${fmtNum((page - 1) * limit + 1)}–${fmtNum(Math.min(page * limit, total))} of ${fmtNum(total)}` : '0 records'}</div>
          <div className="row">
            {onLimit && (
              <select value={limit} onChange={(e) => onLimit(Number(e.target.value))} style={{ width: 90, height: 30 }}>
                {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
            )}
            <button className="btn btn-sm btn-icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous"><Icon name="ChevronLeft" size={15} /></button>
            <span>Page {page} / {Math.max(pages || 1, 1)}</span>
            <button className="btn btn-sm btn-icon" disabled={page >= (pages || 1)} onClick={() => onPage(page + 1)} aria-label="Next"><Icon name="ChevronRight" size={15} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
