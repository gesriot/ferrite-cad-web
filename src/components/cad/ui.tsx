import { clsx } from "clsx";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { displayUnit, formatNum, parseNum } from "@/lib/cad/format";

export function NumField({
  label,
  value,
  onChange,
  unit = "мм",
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  unit?: string;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(formatNum(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(formatNum(value));
  }, [value, focused]);
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input
          inputMode="decimal"
          className="h-10 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 font-mono text-sm text-fg tabular-nums outline-none focus:border-primary"
          value={text}
          onFocus={() => setFocused(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setFocused(false);
            const n = parseNum(text);
            if (n == null) {
              setText(formatNum(value));
              return;
            }
            const next = Math.min(max ?? 1e5, Math.max(min ?? -1e5, n));
            onChange(next);
            setText(formatNum(next));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          }}
        />
        <span className="min-w-8 shrink-0 font-mono text-xs text-faint">{displayUnit(unit)}</span>
      </span>
    </label>
  );
}

export function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={clsx(
        "flex h-10 items-center justify-between gap-3 rounded-sm border border-border bg-bg px-3 text-left text-sm",
        on ? "border-primary text-fg" : "text-muted",
      )}
    >
      <span>{label}</span>
      <span className={clsx("font-mono text-xs", on ? "text-primary" : "text-faint")}>{on ? "On" : "Off"}</span>
    </button>
  );
}

export function ToolButton({
  active,
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      className={clsx(
        "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm transition-colors lg:h-9",
        props.disabled && "cursor-not-allowed opacity-40",
        active ? "bg-primary text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
      {...props}
    >
      {children}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

export function IconBtn({
  label,
  children,
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={clsx(
        "inline-flex size-11 items-center justify-center rounded-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg lg:size-9",
        active && "bg-surface-2 text-brass",
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-border px-3 py-3">
      <h2 className="text-xs font-medium tracking-wide text-faint uppercase">{title}</h2>
      {children}
    </section>
  );
}
