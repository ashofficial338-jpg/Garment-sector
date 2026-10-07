import { useEffect, useRef, useState } from 'react';
import {
  Activity, AlarmClock, AlertCircle, AlertOctagon, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BadgeCheck, BadgeDollarSign, Banknote, BarChart3, Bell, BellOff, BellRing, BookCheck, BookOpenCheck, Boxes, Briefcase, Bug, Building, Building2, Calculator, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, ClipboardCheck, Coins, Crosshair, Crown, Database, Download, Eye, EyeOff, Factory, File, FileBarChart, FileDown, Files, FileSignature, FileSpreadsheet, FileText, FileWarning, FolderOpen, FolderUp, GanttChartSquare, Gauge, GitBranch, GitFork, HandCoins, Hash, History, Hourglass, IdCard, Inbox, Info, KeyRound, Layers, LayoutDashboard, LayoutGrid, Lightbulb, LineChart, List, ListChecks, ListTodo, Loader, Lock, LockOpen, LogIn, LogOut, Menu, MessageSquareText, Minus, Moon, Network, PackageCheck, Pencil, Percent, Plane, Play, Plus, Printer, RadioTower, ReceiptText, RefreshCcw, RefreshCw, Replace, RotateCcw, Rows3, Save, Scissors, Search, SearchX, Shield, ShieldAlert, ShieldCheck, Ship, Shirt, SlidersHorizontal, Sparkles, Spline, Stamp, Sun, Table, Tag, Target, Trash2, TrendingUp, Truck, Upload, UserCog, UserPlus, Users, Wallet, Warehouse, Workflow, Wrench, X, XCircle,
} from 'lucide-react';

/** Explicit icon registry (keeps the bundle small – add new icons here). */
const Icons = {
  Activity, AlarmClock, AlertCircle, AlertOctagon, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BadgeCheck, BadgeDollarSign, Banknote, BarChart3, Bell, BellOff, BellRing, BookCheck, BookOpenCheck, Boxes, Briefcase, Bug, Building, Building2, Calculator, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, ClipboardCheck, Coins, Crosshair, Crown, Database, Download, Eye, EyeOff, Factory, File, FileBarChart, FileDown, Files, FileSignature, FileSpreadsheet, FileText, FileWarning, FolderOpen, FolderUp, GanttChartSquare, Gauge, GitBranch, GitFork, HandCoins, Hash, History, Hourglass, IdCard, Inbox, Info, KeyRound, Layers, LayoutDashboard, LayoutGrid, Lightbulb, LineChart, List, ListChecks, ListTodo, Loader, Lock, LockOpen, LogIn, LogOut, Menu, MessageSquareText, Minus, Moon, Network, PackageCheck, Pencil, Percent, Plane, Play, Plus, Printer, RadioTower, ReceiptText, RefreshCcw, RefreshCw, Replace, RotateCcw, Rows3, Save, Scissors, Search, SearchX, Shield, ShieldAlert, ShieldCheck, Ship, Shirt, SlidersHorizontal, Sparkles, Spline, Stamp, Sun, Table, Tag, Target, Trash2, TrendingUp, Truck, Upload, UserCog, UserPlus, Users, Wallet, Warehouse, Workflow, Wrench, X, XCircle,
};
import { fmtNum } from '../utils/format.js';

/** Render a lucide icon by name */
export function Icon({ name, size = 18, ...rest }) {
  const C = Icons[name] || Icons.Circle;
  return <C size={size} strokeWidth={1.9} {...rest} />;
}

const GREEN = ['done', 'Approved', 'Completed', 'Passed', 'Fully Paid', 'Closed', 'Shipped', 'Delivered', 'Final Approved', 'Active', 'Verified', 'Reconciled', 'Received', 'Issued', 'Fully Consumed', 'Fabric Job Closed', 'Consumed', 'Held', 'completed', 'Ready', 'Yes'];
const AMBER = ['active', 'In Progress', 'Booked', 'Submitted', 'Sent', 'Under Review', 'Buyer Review', 'Partial', 'Running', 'Released', 'Inspection', 'Re-inspection', 'Packed', 'Stuffed', 'In Production', 'In Transit', 'Inspected', 'Scheduled', 'Revised', 'Costing', 'Quoted', 'On Leave', 'inProgress', 'Planned', 'Open', 'On Hold'];
const RED = ['delayed', 'Rejected', 'Failed', 'Cancelled', 'Delayed', 'Resigned', 'Issue', 'Inactive'];
const VIOLET = ['Ready to Close', 'READY TO CLOSE', 'READY TO CLOSE / EXCESS BALANCE'];
const BLUE = ['Confirmed', 'Converted', 'Draft'];

export function statusTone(s) {
  if (!s) return 'grey';
  if (GREEN.includes(s)) return 'green';
  if (VIOLET.includes(s) || String(s).startsWith('READY')) return 'violet';
  if (RED.includes(s)) return 'red';
  if (AMBER.includes(s)) return 'amber';
  if (BLUE.includes(s)) return 'blue';
  return 'grey';
}

export const Badge = ({ tone = 'grey', children, dot = true, title }) => (
  <span className={`badge b-${tone} ${dot ? '' : 'nodot'}`} title={title}>{children}</span>
);
export const StatusBadge = ({ status }) => (status ? <Badge tone={statusTone(status)}>{status}</Badge> : <span className="muted">—</span>);

/** Animated counter */
export function AnimatedNumber({ value = 0, decimals = 0, format }) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const target = Number(value) || 0;
    const start = performance.now();
    const begin = from.current;
    let raf;
    const tick = (t) => {
      const p = Math.min((t - start) / 700, 1);
      const eased = 1 - (1 - p) ** 3;
      setV(begin + (target - begin) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format ? format(v) : fmtNum(v, decimals)}</>;
}

export function Kpi({ label, value, sub, icon, tone = 'primary', decimals = 0, format, onClick, delay = 0 }) {
  return (
    <div className={`card kpi tone-${tone} rise`} style={{ animationDelay: `${delay}ms`, cursor: onClick ? 'pointer' : undefined }} onClick={onClick}>
      <div className="ico"><Icon name={icon} size={19} /></div>
      <div className="lbl">{label}</div>
      <div className={`val ${typeof value === 'number' ? '' : 'val-text'}`}>{typeof value === 'number' ? <AnimatedNumber value={value} decimals={decimals} format={format} /> : value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export const Progress = ({ value = 0, color }) => (
  <div className="progress"><span style={{ width: `${Math.max(0, Math.min(100, value))}%`, ...(color ? { background: color } : {}) }} /></div>
);

export const Spinner = () => <div className="spinner" />;
export const Loading = () => <div className="center-page"><Spinner /></div>;

export function Empty({ icon = 'Inbox', title = 'Nothing here yet', children }) {
  return (
    <div className="empty">
      <Icon name={icon} size={38} />
      <div style={{ fontWeight: 650, color: 'var(--text-2)' }}>{title}</div>
      {children && <div className="small" style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

export function PageHead({ title, subtitle, crumbs, children, icon }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1 className="row">{icon && <Icon name={icon} size={22} style={{ color: 'var(--primary)' }} />}{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="row-wrap">{children}</div>}
    </div>
  );
}

export function Card({ title, icon, actions, children, pad = true, className = '', style }) {
  return (
    <div className={`card ${className}`} style={style}>
      {(title || actions) && (
        <div className="card-head">
          <h3>{icon && <Icon name={icon} size={16} style={{ color: 'var(--primary)' }} />}{title}</h3>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {pad ? <div className="card-body">{children}</div> : <div className="table-wrap">{children}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => {
        const key = typeof t === 'string' ? t : t.key;
        const label = typeof t === 'string' ? t : t.label;
        return <button key={key} type="button" className={`tab ${value === key ? 'on' : ''}`} onClick={() => onChange(key)}>{label}</button>;
      })}
    </div>
  );
}

export function Modal({ title, children, footer, onClose, width }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Drawer({ title, subtitle, children, footer, onClose, headExtra }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          {headExtra}
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon name="X" /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Field({ label, required, error, hint, children, span }) {
  return (
    <div className={`field ${error ? 'has-err' : ''} ${span ? 'span-2' : ''}`}>
      {label && <label>{label}{required && <span className="req"> *</span>}</label>}
      {children}
      {error && <div className="err">{error}</div>}
      {!error && hint && <div className="hint">{hint}</div>}
    </div>
  );
}
