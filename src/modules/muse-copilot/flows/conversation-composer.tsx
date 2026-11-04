import { ArrowUp, Camera, ImagePlus } from "lucide-react";
import { useEffect, useRef, type FormEvent, type ReactNode } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";

/**
 * Keyboard-safe composer. Controlled draft lives in the caller so failures
 * can restore the unsent text and route transitions can preserve it. The
 * textarea grows with content; Enter submits, Shift+Enter inserts a
 * newline. An optional attach slot hosts the plate photo picker.
 */
export function ConversationComposer({
  attach,
  busy,
  copy,
  draft,
  followUp,
  onDraftChange,
  onSend,
}: {
  readonly attach?: ReactNode | undefined;
  readonly busy: boolean;
  readonly copy: CopilotCopy;
  readonly draft: string;
  readonly followUp: boolean;
  readonly onDraftChange: (draft: string) => void;
  readonly onSend: (text: string) => void;
}): ReactNode {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  // Intentionally runs every render: keeps the expanding textarea sized to
  // its content, including programmatic draft changes (retry restores,
  // session restores). Cheap single-element style sync, no dep array needed.
  useEffect(() => {
    const area = areaRef.current;

    if (area === null) {
      return;
    }

    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  });

  const trySubmit = (): void => {
    const text = draft.trim();

    if (text === "" || busy) {
      return;
    }

    onSend(text);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    trySubmit();
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      {attach}

      <label htmlFor="muse-composer" className="sr-only">
        {followUp ? copy.composerFollowUp : copy.composerPlaceholder}
      </label>

      <textarea
        ref={areaRef}
        id="muse-composer"
        rows={1}
        value={draft}
        disabled={busy}
        onChange={(event) => {
          onDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            trySubmit();
          }
        }}
        placeholder={followUp ? copy.composerFollowUp : copy.composerPlaceholder}
        autoComplete="off"
        enterKeyHint="send"
        className="max-h-36 min-h-11 min-w-0 flex-1 resize-none rounded-2xl border border-border-soft bg-white px-4 py-2.5 text-base leading-relaxed text-ink outline-none placeholder:text-muted focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40 disabled:opacity-60"
      />

      <button
        type="submit"
        disabled={busy || draft.trim() === ""}
        aria-label={copy.sendAction}
        className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full bg-food-orange-strong text-white transition hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ArrowUp aria-hidden="true" className="size-5" />
      </button>
    </form>
  );
}

/**
 * Photo capture buttons for the composer (mockup: image + camera beside
 * the send action). Plain buttons — the hidden file inputs live in the
 * plate panel, which owns validation and upload. Disabled while busy.
 */
export function PhotoAttachButtons({
  busy,
  cameraLabel,
  galleryLabel,
  onCamera,
  onGallery,
}: {
  readonly busy: boolean;
  readonly cameraLabel: string;
  readonly galleryLabel: string;
  readonly onCamera: () => void;
  readonly onGallery: () => void;
}) {
  const shared = `inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border border-border-soft bg-white text-ink transition hover:border-food-orange-strong ${
    busy ? "pointer-events-none opacity-50" : ""
  }`;

  return (
    <>
      <button
        type="button"
        onClick={onGallery}
        disabled={busy}
        aria-label={galleryLabel}
        title={galleryLabel}
        className={shared}
      >
        <ImagePlus aria-hidden="true" className="size-5" />
      </button>

      <button
        type="button"
        onClick={onCamera}
        disabled={busy}
        aria-label={cameraLabel}
        title={cameraLabel}
        className={shared}
      >
        <Camera aria-hidden="true" className="size-5" />
      </button>
    </>
  );
}
