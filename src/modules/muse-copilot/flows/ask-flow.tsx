import { useRef, useState, type ReactNode } from "react";

import {
  BusyStage,
  Composer,
  ConversationThread,
  CopilotCards,
  FlowAlert,
  FlowShell,
  FollowUpChips,
  type CopilotMessage,
  type FlowProps,
} from "@/modules/muse-copilot/flows/conversation";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";
import { copilotChatOutputSchema } from "@/server/muse-copilot/copilot-schemas";
import { copilotChatFn } from "@/server/muse-copilot/copilot.functions";

const copy = {
  en: {
    title: "Ask Muse",
    intro: "Ask a short question about a dish or place, like how spicy it is or what is in it.",
    scopedDish: "About this dish",
    scopedVenue: "About this place",
    unscoped:
      "No dish or place selected yet — answers stay general. Find something first to ask about it.",
    placeholder: "e.g. is it usually spicy?",
    send: "Send",
    you: "You",
    muse: "Muse",
    thinking: "Thinking…",
    failed: "The answer did not finish. Try again when ready.",
    retry: "Try again",
    viewDish: "View dish",
    viewVenue: "View place",
  },
  vi: {
    title: "Hỏi Muse",
    intro: "Hỏi ngắn về một món ăn hoặc quán, như độ cay hay thành phần của món.",
    scopedDish: "Về món này",
    scopedVenue: "Về quán này",
    unscoped:
      "Chưa chọn món hay quán nào — câu trả lời chỉ mang tính chung. Hãy tìm trước rồi hỏi.",
    placeholder: "vd. món này thường có cay không?",
    send: "Gửi",
    you: "Bạn",
    muse: "Muse",
    thinking: "Đang nghĩ…",
    failed: "Câu trả lời chưa xong. Thử lại khi bạn sẵn sàng.",
    retry: "Thử lại",
    viewDish: "Xem món",
    viewVenue: "Xem quán",
  },
} as const;

interface AssistantEnrichment {
  readonly messageId: string;
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly followUps: ReadonlyArray<string>;
}

/**
 * Ask flow. Compact scoped Q&A: the current dish/venue/scan IDs travel with
 * every question so answers stay about the thing in context. Assistant
 * turns keep role clarity in the thread; the backend's structured cards
 * render beside the answer (never markdown-only bubbles) and cited sources
 * ride the card links. Provider text is always plain text — arbitrary HTML
 * from provider output has no render path.
 */
export default function AskFlow({ context, onUpdateContext }: FlowProps): ReactNode {
  const strings = context.language === "vi" ? copy.vi : copy.en;
  const [messages, setMessages] = useState<ReadonlyArray<CopilotMessage>>([]);
  const [enrichment, setEnrichment] = useState<AssistantEnrichment | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const runId = useRef(0);
  const messageId = useRef(0);

  const nextId = (): string => {
    messageId.current += 1;

    return `ask-${messageId.current}`;
  };

  const send = (text: string): void => {
    const id = runId.current + 1;
    runId.current = id;

    const alive = (): boolean => runId.current === id;

    setMessages((previous) => [...previous, { id: nextId(), role: "user", text }]);
    setFailed(false);
    setBusy(true);

    void copilotChatFn({
      data: {
        message: text,
        task: "ask",
        context: {
          city: context.city,
          country: context.country,
          language: context.language,
          dishId: context.dishId,
          venueId: context.venueId,
          scanId: context.scanId,
        },
      },
    }).then(
      (raw) => {
        if (!alive()) {
          return;
        }

        // AI-derived reply: validate against the peer contract before rendering.
        const parsed = copilotChatOutputSchema.safeParse(raw);

        if (!parsed.success) {
          setBusy(false);
          setFailed(true);

          return;
        }

        const reply = parsed.data;
        const assistantId = nextId();

        setMessages((previous) => [
          ...previous,
          { id: assistantId, role: "assistant", text: reply.reply },
        ]);

        const dishCard = reply.cards.find(
          (card) => card.kind === "dish" && card.refId !== undefined,
        );

        const venueCard = reply.cards.find(
          (card) => card.kind === "restaurant" && card.refId !== undefined,
        );

        if (dishCard?.refId !== undefined || venueCard?.refId !== undefined) {
          onUpdateContext({ dishId: dishCard?.refId, venueId: venueCard?.refId });
        }

        if (reply.cards.length > 0 || reply.followUps.length > 0) {
          setEnrichment({ messageId: assistantId, cards: reply.cards, followUps: reply.followUps });
        } else {
          setEnrichment(null);
        }

        setBusy(false);
        setFailed(false);
      },
      () => {
        if (alive()) {
          setBusy(false);
          setFailed(true);
        }
      },
    );
  };

  let scopeLine: string = strings.unscoped;

  if (context.dishId !== undefined) {
    scopeLine = strings.scopedDish;
  } else if (context.venueId !== undefined) {
    scopeLine = strings.scopedVenue;
  }

  return (
    <FlowShell title={strings.title} intro={strings.intro}>
      <p className="text-xs font-bold tracking-wide text-muted uppercase">{scopeLine}</p>

      <ConversationThread messages={messages} museLabel={strings.muse} youLabel={strings.you} />

      {enrichment === null ? null : (
        <>
          <CopilotCards
            cards={enrichment.cards}
            language={context.language}
            onUpdateContext={onUpdateContext}
            viewDishLabel={strings.viewDish}
            viewVenueLabel={strings.viewVenue}
          />

          <FollowUpChips busy={busy} items={enrichment.followUps} onPick={send} />
        </>
      )}

      <BusyStage stage={busy ? strings.thinking : null} />

      {failed ? (
        <FlowAlert
          message={strings.failed}
          onRetry={() => {
            setFailed(false);
          }}
          retryLabel={strings.retry}
        />
      ) : null}

      <Composer
        busy={busy}
        onSend={send}
        placeholder={strings.placeholder}
        sendLabel={strings.send}
      />
    </FlowShell>
  );
}
