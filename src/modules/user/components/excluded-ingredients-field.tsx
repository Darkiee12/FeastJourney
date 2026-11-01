import type { Messages } from "@/shared/i18n";

/**
 * Single unified "Ingredients to avoid" field, shared by the quiz final
 * step (mobile drawer + desktop card) and the member account settings.
 * One field, one copy set, one behavior: comma-separated ingredients,
 * normalized by the caller's parseCommaList. Do not add a second
 * allergy/dislike input anywhere — this component is the only one.
 */
export function ExcludedIngredientsField({
  compact = false,
  copy,
  disabled = false,
  id,
  onChange,
  value,
}: {
  readonly compact?: boolean;
  readonly copy: Messages;
  readonly disabled?: boolean;
  readonly id: string;
  readonly onChange: (next: string) => void;
  readonly value: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-bold text-ink">
        {copy.recExcludedLabel}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={copy.recExcludedPlaceholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="min-h-11 w-full rounded-xl border-2 border-border-soft bg-cream px-4 py-3 text-base text-ink placeholder:text-muted focus:border-brand-blue disabled:cursor-not-allowed disabled:opacity-60"
      />
      <p className={compact ? "mt-1.5 text-xs text-muted" : "mt-2 text-sm text-muted"}>
        {copy.recExcludedNote}
      </p>
    </div>
  );
}
