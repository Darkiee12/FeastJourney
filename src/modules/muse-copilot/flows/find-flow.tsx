import { useRef, useState, type ReactNode } from "react";

import {
  BusyStage,
  Composer,
  ConversationThread,
  CopilotCards,
  FlowAlert,
  FlowShell,
  FollowUpChips,
  ResearchFallback,
  type FlowProps,
  type CopilotMessage,
} from "@/modules/muse-copilot/flows/conversation";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";
import { copilotChatOutputSchema } from "@/server/muse-copilot/copilot-schemas";
import { copilotChatFn } from "@/server/muse-copilot/copilot.functions";
import { researchDishesFn } from "@/server/web-research/research-functions";

const copy = {
  en: {
    title: "Find food",
    intro:
      "Describe what you crave and where you are. Muse answers from the catalog first and only reaches for web research when the catalog is not enough.",
    scope: "Searching",
    placeholder: "e.g. smoky grilled breakfast near me",
    send: "Send",
    you: "You",
    muse: "Muse",
    thinking: "Thinking…",
    failed: "The chat did not finish. Try again when ready.",
    retry: "Try again",
    viewDish: "View dish",
    viewVenue: "View place",
    researchHint: "Catalog not enough? Web research goes beyond it, with sources.",
  },
  vi: {
    title: "Tìm món",
    intro:
      "Mô tả món bạn thèm và nơi bạn đang ở. Muse trả lời từ danh mục trước, chỉ tìm thêm trên web khi danh mục chưa đủ.",
    scope: "Đang tìm",
    placeholder: "vd. món nướng khói buổi sáng gần đây",
    send: "Gửi",
    you: "Bạn",
    muse: "Muse",
    thinking: "Đang nghĩ…",
    failed: "Cuộc trò chuyện chưa xong. Thử lại khi bạn sẵn sàng.",
    retry: "Thử lại",
    viewDish: "Xem món",
    viewVenue: "Xem quán",
    researchHint: "Danh mục chưa đủ? Tìm trên web vượt ngoài danh mục, kèm nguồn.",
  },
} as const;

interface AssistantEnrichment {
  readonly messageId: string;
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly followUps: ReadonlyArray<string>;
}

/**
 * Find flow. Conversational discovery over the catalog: the backend's
 * structured reply (plain-text answer plus dish/restaurant/price/source
 * cards and follow-ups) renders verbatim — never reworded, never extended.
 * Dish and restaurant card IDs are preserved into context and offered as
 * canonical catalog links; web research stays an explicit opt-in fallback
 * with provenance badges for when the catalog is insufficient.
 */
export default function FindFlow({ context, onUpdateContext }: FlowProps): ReactNode {
  const strings = context.language === "vi" ? copy.vi : copy.en;
  const [messages, setMessages] = useState<ReadonlyArray<CopilotMessage>>([]);
  const [enrichment, setEnrichment] = useState<AssistantEnrichment | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const runId = useRef(0);
  const messageId = useRef(0);

  const nextId = (): string => {
    messageId.current += 1;

    return `find-${messageId.current}`;
  };

  const send = (text: string): void => {
    const id = runId.current + 1;
    runId.current = id;

    const alive = (): boolean => runId.current === id;
    const userMessage: CopilotMessage = { id: nextId(), role: "user", text };

    setMessages((previous) => [...previous, userMessage]);
    setFailed(false);
    setBusy(true);

    void copilotChatFn({
      data: {
        message: text,
        task: "find",
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

  const scopeParts: Array<string> = [];

  if (context.city !== undefined && context.city !== "") {
    scopeParts.push(context.city);
  }

  if (context.country !== undefined && context.country !== "") {
    scopeParts.push(context.country);
  }

  const canResearch = context.city !== undefined && context.country !== undefined;

  return (
    <FlowShell title={strings.title} intro={strings.intro}>
      {scopeParts.length === 0 ? null : (
        <p className="text-xs font-bold tracking-wide text-muted uppercase">
          {strings.scope}: {scopeParts.join(" · ")}
        </p>
      )}

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

      {canResearch ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted">{strings.researchHint}</p>

          <ResearchFallback
            language={context.language}
            load={() =>
              researchDishesFn({
                data: {
                  city: context.city ?? "",
                  country: context.country ?? "",
                  language: context.language,
                },
              })
            }
          />
        </div>
      ) : null}
    </FlowShell>
  );
}
