/**
 * User-facing copy for the Muse copilot shell. English ships the reviewed
 * wording; Vietnamese ships a polished native translation. This copy only
 * describes the copilot flow and its unverified status — never machine-
 * translated dietary facts, and no AI implementation jargon.
 */

/** Every user-visible string the copilot shell, landing, and cards need. */
export interface CopilotCopy {
  readonly shellTitle: string;
  readonly shellSubtitle: string;
  readonly askMuseAction: string;
  readonly landingTitle: string;
  readonly landingSubtitle: string;
  readonly taskScanTitle: string;
  readonly taskScanBlurb: string;
  readonly taskPlateTitle: string;
  readonly taskPlateBlurb: string;
  readonly taskFindTitle: string;
  readonly taskFindBlurb: string;
  readonly taskAskTitle: string;
  readonly taskAskBlurb: string;
  readonly taskOrderTitle: string;
  readonly taskOrderBlurb: string;
  readonly comingSoon: string;
  readonly back: string;
  readonly startOver: string;
  readonly retryAction: string;
  readonly loadingFlow: string;
  readonly failureTitle: string;
  readonly failureBody: string;
}

export const enCopilotCopy: CopilotCopy = {
  shellTitle: "Muse",
  shellSubtitle: "Your food companion for the trip.",
  askMuseAction: "Ask Muse",
  landingTitle: "What can Muse do for you?",
  landingSubtitle:
    "Point your camera, look up a dish, find a place, ask a question, or get help ordering.",
  taskScanTitle: "Scan a menu",
  taskScanBlurb: "Point your camera at a menu to read it in your language.",
  taskPlateTitle: "Know your plate",
  taskPlateBlurb: "Look up a dish: what it is and what is in it.",
  taskFindTitle: "Find it nearby",
  taskFindBlurb: "Find checked places serving the dish you crave.",
  taskAskTitle: "Ask about food",
  taskAskBlurb: "Ask anything about local food and where to eat.",
  taskOrderTitle: "Order with confidence",
  taskOrderBlurb: "Build a two-language order to show your server.",
  comingSoon: "Coming soon",
  back: "Back",
  startOver: "Start over",
  retryAction: "Try again",
  loadingFlow: "Getting things ready…",
  failureTitle: "Something did not work.",
  failureBody: "Your details are safe. Try again when you are ready.",
};

export const viCopilotCopy: CopilotCopy = {
  shellTitle: "Muse",
  shellSubtitle: "Bạn đồng hành ẩm thực cho chuyến đi.",
  askMuseAction: "Hỏi Muse",
  landingTitle: "Muse giúp gì cho bạn?",
  landingSubtitle: "Chụp thực đơn, tìm hiểu món ăn, tìm quán, đặt câu hỏi, hoặc nhờ gọi món giúp.",
  taskScanTitle: "Chụp thực đơn",
  taskScanBlurb: "Hướng camera vào thực đơn để đọc bằng tiếng của bạn.",
  taskPlateTitle: "Hiểu món ăn",
  taskPlateBlurb: "Tra cứu món ăn: món gì và gồm những gì.",
  taskFindTitle: "Tìm quán gần đây",
  taskFindBlurb: "Tìm quán đã kiểm chứng có món bạn thèm.",
  taskAskTitle: "Hỏi về món ăn",
  taskAskBlurb: "Hỏi mọi điều về món ngon và quán ăn địa phương.",
  taskOrderTitle: "Tự tin gọi món",
  taskOrderBlurb: "Soạn phiếu gọi món song ngữ để đưa cho quán.",
  comingSoon: "Sắp ra mắt",
  back: "Quay lại",
  startOver: "Bắt đầu lại",
  retryAction: "Thử lại",
  loadingFlow: "Đang chuẩn bị…",
  failureTitle: "Có chút trục trặc.",
  failureBody: "Thông tin của bạn vẫn còn. Thử lại khi bạn sẵn sàng nhé.",
};

export type CopilotLanguage = "en" | "vi";

/** Reviewed copilot copy; every other locale reads English. */
export const copilotCopyFor = (language: CopilotLanguage): CopilotCopy =>
  language === "vi" ? viCopilotCopy : enCopilotCopy;
