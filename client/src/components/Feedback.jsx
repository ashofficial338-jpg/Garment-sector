/** Toasts + promise-based dialogs (confirm, reason prompt) */
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Icon, Modal, Field } from './ui.jsx';

const Ctx = createContext(null);

export function FeedbackProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const resolver = useRef(null);
  const [text, setText] = useState('');

  const toast = useCallback((msg, type = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'err' ? 6500 : 3800);
  }, []);

  const open = (cfg) => new Promise((resolve) => { resolver.current = resolve; setText(cfg.defaultValue || ''); setDialog(cfg); });
  const confirm = useCallback((message, opts = {}) => open({ kind: 'confirm', message, ...opts }), []);
  /** Ask for a mandatory reason (overrides, deletes, closures). Resolves null when cancelled. */
  const askReason = useCallback((message, opts = {}) => open({ kind: 'reason', message, ...opts }), []);

  const close = (val) => { resolver.current?.(val); setDialog(null); };

  return (
    <Ctx.Provider value={{ toast, confirm, askReason }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon name={t.type === 'ok' ? 'CheckCircle2' : t.type === 'warn' ? 'AlertTriangle' : 'XCircle'} />
            <div style={{ whiteSpace: 'pre-line' }}>{t.msg}</div>
          </div>
        ))}
      </div>
      {dialog && (
        <Modal
          title={dialog.title || (dialog.kind === 'reason' ? 'Reason required' : 'Please confirm')}
          onClose={() => close(dialog.kind === 'reason' ? null : false)}
          footer={(
            <>
              <button className="btn" onClick={() => close(dialog.kind === 'reason' ? null : false)}>Cancel</button>
              <button
                className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`}
                disabled={dialog.kind === 'reason' && !text.trim() && !dialog.optional}
                onClick={() => close(dialog.kind === 'reason' ? text.trim() : true)}
              >{dialog.confirmLabel || 'Confirm'}</button>
            </>
          )}
        >
          <div style={{ whiteSpace: 'pre-line', color: 'var(--text-2)' }}>{dialog.message}</div>
          {dialog.kind === 'reason' && (
            <div className="mt">
              <Field label={dialog.label || 'Reason'} required={!dialog.optional}>
                <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="This will be recorded in the audit trail" />
              </Field>
            </div>
          )}
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useFeedback = () => useContext(Ctx);
