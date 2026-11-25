import { useEffect, useRef, type ReactNode } from "react";
import { X, ArrowUpRight, ShieldCheck, LockKeyhole } from "lucide-react";
export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`card ${className}`}>{children}</section>;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <ShieldCheck size={25} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Locked({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="locked-note">
      <LockKeyhole size={16} />
      <span>
        Bundled config · read-only. Live data aur changes ke liye owner login
        karo.
      </span>
      <button className="text-btn" onClick={onLogin}>
        Login <ArrowUpRight size={14} />
      </button>
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = ref.current!;
    const focus = () =>
      el.querySelector<HTMLElement>("button,input,select,textarea")?.focus();
    focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const all = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        );
        const first = all[0],
          last = all.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.style.overflow = "";
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Toggle({
  label,
  note,
  value,
  onChange,
  disabled,
}: {
  label: string;
  note: string;
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
  disabled: boolean;
}) {
  return (
    <div className="setting-row">
      <div>
        <h3>{label}</h3>
        <p>{note}</p>
      </div>
      <select
        aria-label={label}
        disabled={disabled}
        value={value === undefined ? "inherit" : String(value)}
        onChange={(e) =>
          onChange(
            e.target.value === "inherit"
              ? undefined
              : e.target.value === "true",
          )
        }
      >
        <option value="inherit">App default</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </div>
  );
}
