import { ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function CollapsiblePanel({
  title,
  badge,
  defaultOpen,
  action,
  children,
}: {
  readonly title: string;
  readonly badge?: ReactNode;
  readonly defaultOpen: boolean;
  /** Optional section Edit affordance; renders beside the toggle, never inside it. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const buttonId = useId();
  const panelId = useId();

  return (
    <section
      aria-labelledby={buttonId}
      className="min-w-0 rounded-2xl border border-border-soft bg-white"
    >
      <h2 className="min-w-0">
        <div className="flex min-w-0 items-center gap-2 px-4 py-2">
          <button
            type="button"
            id={buttonId}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              setOpen((previous) => !previous);
            }}
            className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-xl py-1 text-left"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-lg font-bold">{title}</span>
              {badge === undefined ? null : <span className="flex items-center">{badge}</span>}
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className={`size-4 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          </button>
          {action === undefined ? null : <span className="flex shrink-0">{action}</span>}
        </div>
      </h2>
      {open ? (
        <div id={panelId} className="min-w-0 px-4 pb-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
