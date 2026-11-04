/**
 * Conversation barrel: one import path for the workspace primitives.
 * Message bubbles, assistant blocks, cards, composer, suggestions,
 * indicators, errors, and context chips each live in their own module —
 * nothing here is a giant JSX component.
 */

export { CopilotCards } from "@/modules/muse-copilot/flows/conversation-cards";

export {
  ConversationComposer,
  PhotoAttachButtons,
} from "@/modules/muse-copilot/flows/conversation-composer";

export { ConversationViewport } from "@/modules/muse-copilot/flows/conversation-viewport";

export {
  ContextChipRow,
  FollowUpChips,
  ProcessingIndicator,
  RecoverableError,
  ResearchFallback,
  parseResearchOutcome,
} from "@/modules/muse-copilot/flows/conversation-feedback";

export {
  ChatSendResult,
  PhotoIdentifyResult,
  buildTurnHistory,
  classifyChatError,
  identifyPhoto,
  sendCopilotChat,
} from "@/modules/muse-copilot/flows/conversation-model";

export type {
  CopilotContext,
  FlowProps,
  MuseContextChip,
  MuseFailure,
  MuseTurn,
  TurnHistoryItem,
} from "@/modules/muse-copilot/journey/types";
