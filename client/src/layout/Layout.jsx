import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NAV } from './nav.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api.js';
import { Icon, Badge, StatusBadge } from '../components/ui.jsx';
import { timeAgo } from '../utils/format.js';

const SEV = { info: ['blue', 'Info'], success: ['green', 'CheckCircle2'], warning: ['amber', 'AlertTriangle'], danger: ['red', 'AlertOctagon'] };

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const nav = useNavigate();
  const box = useRef(null);
  const input = useRef(null);

  useEffect(() => {
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); } };
    const c = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    window.addEventListener('keydown', k); document.addEventListener('mousedown', c);
    return () => { window.removeEventListener('keydown', k); document.removeEventListener('mousedown', c); };
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return undefined; }
    const t = setTimeout(() => api.get('/search', { params: { q } }).then((r) => { setRes(r.data.results); setIdx(0); setOpen(true); }).catch(() => {}), 220);
    return () => clearTimeout(t);
  }, [q]);

  const go = (r) => {
    setOpen(false); setQ('');
    if (r.type === 'Job') nav(`/jobs/${r.jobNo}`);
    else nav(`/m/${r.module}/${r._id}`);
  };
  const ICON = { Job: 'RadioTower', Enquiry: 'MessageSquareText', Quotation: 'FileSignature', Fabric: 'Layers', Trim: 'Tag', Shipment: 'Ship', Invoice: 'ReceiptText', Supplier: 'Truck', Buyer: 'Building2' };

  return (
    <div className="gsearch" ref={box}>
      <Icon name="Search" size={17} />
      <input
        ref={input} className="gsearch-input" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => res.length && setOpen(true)}
        placeholder="Search Job No, PO, Buyer, Style, Fabric, Supplier, BL, Status…"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, res.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter' && res[idx]) go(res[idx]);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <kbd className="hide-sm">Ctrl K</kbd>
      {open && (
        <div className="search-pop">
          {res.length === 0 && <div className="muted small" style={{ padding: 12 }}>No results for “{q}”</div>}
          {res.map((r, i) => (
            <div key={`${r.module}-${r._id}`} className={`search-item ${i === idx ? 'on' : ''}`} onMouseDown={() => go(r)}>
              <div className="avatar" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--primary-50)', color: 'var(--primary)' }}><Icon name={ICON[r.type] || 'File'} size={15} /></div>
              <div className="grow"><div className="t">{r.title}</div><div className="s">{r.subtitle}</div></div>
              <Badge tone="grey" dot={false}>{r.type}</Badge>
              {r.status && <StatusBadge status={r.status} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ rows: [], unread: 0 });
  const nav = useNavigate();
  const box = useRef(null);
  const load = () => api.get('/notifications', { params: { limit: 15 } }).then((r) => setData(r.data)).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    const c = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', c);
    return () => { clearInterval(t); document.removeEventListener('mousedown', c); };
  }, []);
  const click = async (n) => {
    await api.post(`/notifications/${n._id}/read`).catch(() => {});
    setOpen(false); load();
    if (n.link) nav(n.link);
    else if (n.jobNo) nav(`/jobs/${n.jobNo}`);
  };
  return (
    <div style={{ position: 'relative' }} ref={box}>
      <button className="btn btn-ghost btn-icon" onClick={() => { setOpen(!open); if (!open) load(); }} aria-label="Notifications">
        <Icon name="Bell" />
        {data.unread > 0 && <span className="count-dot">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="notif-pop">
          <div className="card-head"><h3>Notifications</h3>
            <div className="row">
              <button className="btn btn-sm btn-ghost" onClick={async () => { await api.post('/notifications/read-all'); load(); }}>Mark all read</button>
              <button className="btn btn-sm" onClick={() => { setOpen(false); nav('/notifications'); }}>View all</button>
            </div>
          </div>
          {data.rows.length === 0 && <div className="empty">You're all caught up</div>}
          {data.rows.map((n) => (
            <div key={n._id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => click(n)}>
              <div className="dot" style={{ background: `var(--${SEV[n.severity]?.[0] || 'blue'}-50)`, color: `var(--${SEV[n.severity]?.[0] || 'blue'})` }}>
                <Icon name={SEV[n.severity]?.[1] || 'Info'} size={16} />
              </div>
              <div className="grow">
                <div style={{ fontWeight: 650, fontSize: 13 }}>{n.title}</div>
                <div className="small muted">{n.message}</div>
                <div className="small muted" style={{ marginTop: 2 }}>{timeAgo(n.createdAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Current Unit: UNIT-1" – shown on every page; Switch Unit only for users assigned to several units. */
function CurrentUnit() {
  const { user, selectUnit } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    const c = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', c);
    return () => document.removeEventListener('mousedown', c);
  }, []);
  const others = user.units.filter((u) => u.code !== user.unit.code);
  return (
    <div style={{ position: 'relative' }} ref={box}>
      <button className="unit-pill" style={{ cursor: others.length ? 'pointer' : 'default' }} onClick={() => others.length && setOpen(!open)} title={others.length ? 'Switch unit' : undefined}>
        <Icon name="Factory" size={14} /><span className="hide-sm">Current Unit:</span> <b>{user.unit.name.toUpperCase()}</b>
        {others.length > 0 && <Icon name="ArrowLeftRight" size={13} />}
      </button>
      {open && (
        <div className="search-pop" style={{ left: 'auto', right: 0, width: 240 }}>
          <div className="muted small" style={{ padding: '8px 12px' }}>Switch unit – the app reloads with that unit's data</div>
          {others.map((u) => <div key={u.code} className="search-item" onClick={() => selectUnit(u.code)}><Icon name="Factory" size={16} /> {u.name.toUpperCase()} <span className="muted small mono">{u.prefix}-…</span></div>)}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const box = useRef(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; } });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);
  useEffect(() => {
    const c = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', c);
    return () => document.removeEventListener('mousedown', c);
  }, []);
  const initials = user.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{ position: 'relative' }} ref={box}>
      <button className="btn btn-ghost" style={{ height: 42, padding: '0 6px' }} onClick={() => setOpen(!open)}>
        <div className="avatar">{initials}</div>
        <div className="hide-sm" style={{ textAlign: 'left', lineHeight: 1.2 }}>
          <div style={{ fontSize: 13 }}>{user.name}</div>
          <div className="muted" style={{ fontSize: 11, fontWeight: 500 }}>{user.role?.name}</div>
        </div>
        <Icon name="ChevronDown" size={14} />
      </button>
      {open && (
        <div className="search-pop" style={{ left: 'auto', right: 0, width: 230 }}>
          <div className="search-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'Sun' : 'Moon'} size={16} /> {theme === 'dark' ? 'Light mode' : 'Dark mode'}</div>
          <div className="search-item" onClick={() => { setOpen(false); nav('/change-password'); }}><Icon name="KeyRound" size={16} /> Change password</div>
          <div className="search-item" onClick={logout}><Icon name="LogOut" size={16} /> Sign out</div>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { can, user } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    api.get('/meta/company').then((r) => { try { sessionStorage.setItem('company', JSON.stringify(r.data)); } catch { /* ignore */ } }).catch(() => {});
  }, []);

  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round"><path d="M8 3 5 5 2 9l3 3 2-1v10h10V11l2 1 3-3-3-4-3-2c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3Z" /></svg>
          </div>
          <div><b>StitchFlow ERP</b><small>{user.unit.name.toUpperCase()} · Order → Shipment</small></div>
        </div>
        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => (i.admin ? user.isAdmin : !i.perm || can(i.perm[0], i.perm[1] || 'view')));
            if (!items.length) return null;
            return (
              <div className="nav-group" key={g.group}>
                <div className="nav-group-title">{g.group}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'}><Icon name={i.icon} size={17} />{i.label}</NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div style={{ color: '#fff', fontWeight: 600 }}>{user.department || user.role?.name}</div>
          <div>{user.isAdmin ? 'Full administrator access' : `${Object.keys(user.permissions || {}).length} modules permitted`}</div>
        </div>
      </aside>
      <div className={`scrim ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon menu-btn" onClick={() => setOpen(true)} aria-label="Menu"><Icon name="Menu" /></button>
          <GlobalSearch />
          <div className="grow" />
          <CurrentUnit />
          <Notifications />
          <UserMenu />
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
