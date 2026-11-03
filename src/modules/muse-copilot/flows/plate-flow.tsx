import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import {
  BusyStage,
  ConversationThread,
  CopilotCards,
  FlowAlert,
  FlowShell,
  FollowUpChips,
  ResearchFallback,
  type CopilotMessage,
  type FlowProps,
} from "@/modules/muse-copilot/flows/conversation";
import { menuScanClient, validateMenuFiles } from "@/modules/restaurant-discovery/menu-scan-client";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";
import { copilotChatOutputSchema } from "@/server/muse-copilot/copilot-schemas";
import { copilotChatFn } from "@/server/muse-copilot/copilot.functions";
import { researchDishesFn } from "@/server/web-research/research-functions";

const uuidSchema = z.uuid();

const copy = {
  en: {
    title: "Know your plate",
    intro:
      "Show Muse a plate and it will suggest what the dish might be. The photo uploads through the menu scanner so it stays yours to revisit; every suggestion is tentative — confirm with the venue before ordering.",
    choosePhoto: "Choose a photo",
    photoHint: "JPEG, PNG, or WebP, up to 8 MiB. The photo is sent for identification only.",
    uploading: "Uploading photo…",
    preparing: "Preparing suggestions…",
    failed: "Photo identification did not finish. Try again when ready.",
    retry: "Try again",
    reset: "Use another photo",
    you: "You",
    muse: "Muse",
    platePrompt: "What dish is in this photo?",
    viewDish: "View dish",
    viewVenue: "View place",
    researchHint: "Still unsure? Web research can look beyond the catalog.",
  },
  vi: {
    title: "Hiểu món ăn",
    intro:
      "Cho Muse xem ảnh món ăn, Muse sẽ gợi ý đó có thể là món gì. Ảnh tải lên qua trình quét thực đơn nên bạn xem lại lúc nào cũng được; mọi gợi ý đều chỉ là phỏng đoán — hãy xác nhận với quán trước khi gọi món.",
    choosePhoto: "Chọn ảnh",
    photoHint: "JPEG, PNG hoặc WebP, tối đa 8 MiB. Ảnh chỉ được gửi để nhận diện.",
    uploading: "Đang tải ảnh lên…",
    preparing: "Đang soạn gợi ý…",
    failed: "Lần nhận diện chưa xong. Thử lại khi bạn sẵn sàng.",
    retry: "Thử lại",
    reset: "Dùng ảnh khác",
    you: "Bạn",
    muse: "Muse",
    platePrompt: "Món trong ảnh này là món gì?",
    viewDish: "Xem món",
    viewVenue: "Xem quán",
    researchHint: "Vẫn chưa chắc? Tìm trên web có thể vượt ngoài danh mục.",
  },
} as const;

interface PlateAnswer {
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly followUps: ReadonlyArray<string>;
}

/**
 * Plate flow. Photo handling reuses the menu scanner's client validation
 * (`validateMenuFiles`: JPEG/PNG/WebP, ≤8 MiB) and its upload pipeline
 * (`menuScanClient.create` + `attach`), so bytes are backend-processed and
 * the photo stays a real scan the traveler can revisit — nothing here
 * copies the scanner or mints storage keys. The created scan ID travels in
 * context to `copilotChatFn` (task `plate`), whose dish cards render with
 * canonical catalog links; a web-research fallback covers the no-match
 * case with provenance badges.
 *
 * Integration note: `copilotIdentifyPhotoFn` takes a server-minted
 * object-store `imageKey` the client cannot derive, so this flow uses the
 * chat path with the scan in context instead.
 */
export default function PlateFlow({ context, onUpdateContext }: FlowProps): ReactNode {
  const strings = context.language === "vi" ? copy.vi : copy.en;
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [messages, setMessages] = useState<ReadonlyArray<CopilotMessage>>([]);
  const [answer, setAnswer] = useState<PlateAnswer | null>(null);
  const runId = useRef(0);
  const photoUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      runId.current += 1;

      if (photoUrlRef.current !== null) {
        URL.revokeObjectURL(photoUrlRef.current);
        photoUrlRef.current = null;
      }
    },
    [],
  );

  const setPreview = (next: string | null): void => {
    if (photoUrlRef.current !== null) {
      URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = null;
    }

    photoUrlRef.current = next;
    setPhotoUrl(next);
  };

  const reset = (): void => {
    runId.current += 1;
    setPreview(null);
    setFile(null);
    setStage(null);
    setFailed(false);
    setDone(false);
    setMessages([]);
    setAnswer(null);
  };

  const identify = (photo: File): void => {
    const id = runId.current + 1;
    runId.current = id;

    const alive = (): boolean => runId.current === id;
    const violation = validateMenuFiles([photo]);

    if (violation !== null) {
      setFailed(true);
      setDone(false);
      setMessages([]);
      setAnswer(null);

      return;
    }

    setPreview(URL.createObjectURL(photo));
    setFile(photo);
    setFailed(false);
    setDone(false);
    setMessages([]);
    setAnswer(null);
    setStage(strings.uploading);

    const parsedVenue = uuidSchema.safeParse(context.venueId);
    const venueId = parsedVenue.success ? parsedVenue.data : null;

    void menuScanClient
      .create({ targetLanguage: context.language, venueId })
      .then((created) => menuScanClient.attach(created.id, 1, photo).then(() => created.id))
      .then((scanId) => {
        if (!alive()) {
          return null;
        }

        onUpdateContext({ scanId });
        setStage(strings.preparing);

        return copilotChatFn({
          data: {
            message: strings.platePrompt,
            task: "plate",
            context: {
              city: context.city,
              country: context.country,
              language: context.language,
              dishId: context.dishId,
              venueId: context.venueId,
              scanId,
            },
          },
        });
      })
      .then(
        (raw) => {
          if (!alive() || raw === null) {
            return;
          }

          // AI-derived reply: validate against the peer contract before rendering.
          const parsed = copilotChatOutputSchema.safeParse(raw);

          if (!parsed.success) {
            setStage(null);
            setFailed(true);
            setDone(false);

            return;
          }

          const reply = parsed.data;

          setMessages([{ id: "plate-1", role: "assistant", text: reply.reply }]);

          const dishCard = reply.cards.find(
            (card) => card.kind === "dish" && card.refId !== undefined,
          );

          const venueCard = reply.cards.find(
            (card) => card.kind === "restaurant" && card.refId !== undefined,
          );

          if (dishCard?.refId !== undefined || venueCard?.refId !== undefined) {
            onUpdateContext({ dishId: dishCard?.refId, venueId: venueCard?.refId });
          }

          setAnswer({ cards: reply.cards, followUps: reply.followUps });
          setStage(null);
          setFailed(false);
          setDone(true);
        },
        () => {
          if (alive()) {
            setStage(null);
            setFailed(true);
            setDone(false);
          }
        },
      );
  };

  const ask = (text: string): void => {
    if (stage !== null) {
      return;
    }

    const id = runId.current + 1;
    runId.current = id;

    const alive = (): boolean => runId.current === id;

    setMessages((previous) => [...previous, { id: `plate-q-${id}`, role: "user", text }]);
    setStage(strings.preparing);

    void copilotChatFn({
      data: {
        message: text,
        task: "plate",
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
          setStage(null);
          setFailed(true);

          return;
        }

        const reply = parsed.data;

        setMessages((previous) => [
          ...previous,
          { id: `plate-a-${id}`, role: "assistant", text: reply.reply },
        ]);
        setAnswer({ cards: reply.cards, followUps: reply.followUps });
        setStage(null);
      },
      () => {
        if (alive()) {
          setStage(null);
          setFailed(true);
        }
      },
    );
  };

  const canResearch = done && context.city !== undefined && context.country !== undefined;

  return (
    <FlowShell title={strings.title} intro={strings.intro}>
      <label
        htmlFor="copilot-plate-photo"
        className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
      >
        {strings.choosePhoto}
      </label>

      <input
        id="copilot-plate-photo"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        disabled={stage !== null}
        onChange={(event) => {
          const picked = event.target.files?.[0];

          if (picked !== undefined) {
            identify(picked);
          }

          event.target.value = "";
        }}
      />

      <p className="text-xs leading-relaxed text-muted">{strings.photoHint}</p>

      {photoUrl === null ? null : (
        <img
          src={photoUrl}
          alt=""
          className="w-full rounded-2xl border border-border-soft object-cover"
        />
      )}

      <BusyStage stage={stage} />

      <ConversationThread messages={messages} museLabel={strings.muse} youLabel={strings.you} />

      {answer === null ? null : (
        <>
          <CopilotCards
            cards={answer.cards}
            language={context.language}
            onUpdateContext={onUpdateContext}
            viewDishLabel={strings.viewDish}
            viewVenueLabel={strings.viewVenue}
          />

          <FollowUpChips busy={stage !== null} items={answer.followUps} onPick={ask} />
        </>
      )}

      {failed ? (
        <FlowAlert
          message={strings.failed}
          onRetry={() => {
            if (file !== null) {
              identify(file);
            } else {
              reset();
            }
          }}
          retryLabel={strings.retry}
        />
      ) : null}

      {done && !failed ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
          >
            {strings.reset}
          </button>

          {canResearch ? (
            <>
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
            </>
          ) : null}
        </div>
      ) : null}
    </FlowShell>
  );
}
