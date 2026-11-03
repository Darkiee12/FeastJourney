import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Select } from "radix-ui";
import { Fragment, useId, type ReactNode } from "react";

export interface SharedSelectOption {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
}

export interface SharedSelectSection {
  /** Omitted for ungrouped entries (rendered between groups with separators). */
  readonly label?: string;
  readonly options: ReadonlyArray<SharedSelectOption>;
}

export type SharedSelectSize = "compact" | "regular";

const TRIGGER_BASE_CLASS =
  "group inline-flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border-soft bg-white py-2 pr-2.5 pl-3 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red-400";

const TRIGGER_SIZE_CLASS: ReadonlyMap<SharedSelectSize, string> = new Map([
  ["compact", "min-h-9"],
  ["regular", "min-h-11"],
]);

const ITEM_BASE_CLASS =
  "relative flex cursor-pointer items-center gap-2 rounded-md pr-2.5 pl-8 text-sm text-ink outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-cream motion-reduce:transition-none";

const ITEM_SIZE_CLASS: ReadonlyMap<SharedSelectSize, string> = new Map([
  ["compact", "py-1.5"],
  ["regular", "py-2"],
]);

const GROUP_LABEL_CLASS = "px-2 pt-1.5 pb-0.5 text-xs font-semibold text-muted select-none";

const SEPARATOR_CLASS = "my-1 h-px bg-border-soft";

/**
 * Canonical select. Radix Select supplies the listbox behavior,
 * typeahead, Escape/outside dismissal, and focus restore — no custom
 * positioning or event listeners here. The chevron rotation is driven by the
 * trigger's own `data-state` (open/closed as Radix reports it), never by
 * focus/blur heuristics, so it stays correct after Escape, outside click,
 * or disable-while-open.
 *
 * Scroll-lock note: this Radix version always mounts a `remove-scroll` body
 * lock while the listbox is open (there is no `modal` prop to opt out).
 * The no-shift behavior for that lock lives in `src/styles.css`, which
 * restores document flow for select/menu-only locks and keeps genuine
 * modal locks (dialogs, drawers) intact. Do not add per-trigger margin or
 * width hacks here.
 *
 * Positioning: portaled content with popper collision handling, so the
 * listbox escapes scrolled ancestors (mobile bottom sheets, desktop
 * drawers, scrolled panels) without map/sheet gesture conflicts.
 */
export function SharedSelect({
  ariaLabel,
  contentClassName,
  describedBy,
  disabled,
  id,
  invalid,
  labelledBy,
  leadingIcon,
  onOpenChange,
  onValueChange,
  open,
  options,
  placeholder,
  required,
  sections,
  size,
  triggerClassName,
  value,
}: {
  readonly ariaLabel?: string;
  readonly contentClassName?: string;
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly invalid?: boolean;
  readonly labelledBy?: string;
  readonly leadingIcon?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onValueChange: (value: string) => void;
  readonly open?: boolean;
  readonly options?: ReadonlyArray<SharedSelectOption>;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly sections?: ReadonlyArray<SharedSelectSection>;
  readonly size?: SharedSelectSize;
  readonly triggerClassName?: string;
  readonly value: string | undefined;
}): ReactNode {
  const resolvedSize = size ?? "regular";
  const triggerSize = TRIGGER_SIZE_CLASS.get(resolvedSize) ?? "min-h-11";
  const itemSize = ITEM_SIZE_CLASS.get(resolvedSize) ?? "py-2";
  const visibleSections = (sections ?? []).filter((section) => section.options.length > 0);
  const grouped = visibleSections.length > 0;
  const flatOptions = options ?? [];

  const renderOptions = (entries: ReadonlyArray<SharedSelectOption>): ReactNode =>
    entries.map((option) => (
      <Select.Item
        key={option.value}
        value={option.value}
        disabled={option.disabled ?? false}
        className={`${ITEM_BASE_CLASS} ${itemSize} data-[state=checked]:font-semibold`}
      >
        <Select.ItemIndicator className="absolute left-2 inline-flex items-center text-food-orange-dark">
          <CheckIcon aria-hidden="true" className="size-4" />
        </Select.ItemIndicator>
        <Select.ItemText>{option.label}</Select.ItemText>
      </Select.Item>
    ));

  return (
    <Select.Root
      value={value ?? ""}
      onValueChange={onValueChange}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      required={required}
    >
      <Select.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid ?? false}
        aria-required={required ?? false}
        className={`${TRIGGER_BASE_CLASS} ${triggerSize} ${triggerClassName ?? "w-full"}`}
      >
        {leadingIcon === undefined ? null : (
          <span aria-hidden="true" className="inline-flex shrink-0 items-center">
            {leadingIcon}
          </span>
        )}
        <Select.Value placeholder={placeholder} />
        <Select.Icon asChild>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={`max-h-[min(16rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border-soft bg-white shadow-lg ${contentClassName ?? "z-50"}`}
        >
          <Select.ScrollUpButton className="flex cursor-default items-center justify-center py-1 text-muted">
            <ChevronUpIcon aria-hidden="true" className="size-4" />
          </Select.ScrollUpButton>
          <Select.Viewport className="p-1">
            {grouped
              ? visibleSections.map((section, index) => (
                  <Fragment key={section.label ?? section.options[0]?.value ?? "section"}>
                    {index === 0 ? null : <Select.Separator className={SEPARATOR_CLASS} />}
                    {section.label === undefined ? (
                      renderOptions(section.options)
                    ) : (
                      <Select.Group>
                        <Select.Label className={GROUP_LABEL_CLASS}>{section.label}</Select.Label>
                        {renderOptions(section.options)}
                      </Select.Group>
                    )}
                  </Fragment>
                ))
              : renderOptions(flatOptions)}
          </Select.Viewport>
          <Select.ScrollDownButton className="flex cursor-default items-center justify-center py-1 text-muted">
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/**
 * Labeled composition over SharedSelect. The visible `<label>` targets the
 * Radix trigger button directly (buttons are labelable), so clicking the
 * label opens the menu; description, error, and required wiring mirrors
 * the native SharedSelect contract.
 */
export function SharedSelectField({
  contentClassName,
  description,
  error,
  id,
  label,
  leadingIcon,
  onValueChange,
  options,
  placeholder,
  required,
  sections,
  size,
  triggerClassName,
  value,
  disabled,
  open,
  onOpenChange,
}: {
  readonly contentClassName?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly error?: string | null;
  readonly id?: string;
  readonly label: string;
  readonly leadingIcon?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onValueChange: (value: string) => void;
  readonly open?: boolean;
  readonly options?: ReadonlyArray<SharedSelectOption>;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly sections?: ReadonlyArray<SharedSelectSection>;
  readonly size?: SharedSelectSize;
  readonly triggerClassName?: string;
  readonly value: string | undefined;
}): ReactNode {
  const generatedId = useId();
  const triggerId = id ?? `shared-select-${generatedId}`;
  const descriptionId = description === undefined ? undefined : `${triggerId}-description`;
  const errorId = `${triggerId}-error`;
  const failure = error ?? null;

  const describedBy = [descriptionId, failure !== null ? errorId : undefined]
    .filter((part) => part !== undefined)
    .join(" ");

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={triggerId} className="text-sm font-semibold">
        {label}
        {required === true ? (
          <span aria-hidden="true" className="text-food-orange-dark">
            {" *"}
          </span>
        ) : null}
      </label>
      {description === undefined ? null : (
        <p id={descriptionId} className="text-sm text-muted">
          {description}
        </p>
      )}
      <SharedSelect
        id={triggerId}
        value={value}
        onValueChange={onValueChange}
        options={options}
        sections={sections}
        placeholder={placeholder}
        disabled={disabled}
        invalid={failure !== null}
        describedBy={describedBy === "" ? undefined : describedBy}
        required={required}
        size={size}
        triggerClassName={triggerClassName}
        contentClassName={contentClassName}
        leadingIcon={leadingIcon}
        open={open}
        onOpenChange={onOpenChange}
      />
      {failure !== null ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-red-800">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
