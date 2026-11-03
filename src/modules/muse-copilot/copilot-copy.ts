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
  /** Single workspace heading (plan §4: one heading, no duplicated titles). */
  readonly workspaceTitle: string;
  readonly workspaceTagline: string;
  /** Entry suggestions; `{city}` interpolates the known city when present. */
  readonly suggestCity: string;
  readonly suggestDish: string;
  readonly suggestFind: string;
  readonly suggestScan: string;
  readonly suggestOrder: string;
  readonly composerPlaceholder: string;
  readonly composerFollowUp: string;
  readonly sendAction: string;
  readonly youLabel: string;
  readonly museLabel: string;
  /** Honest pending stages, each tied to real backend work (plan §9). */
  readonly thinkingCatalog: string;
  readonly thinkingPlaces: string;
  readonly thinkingPhoto: string;
  /** Removable scope chips (plan §17); `{name}` interpolates the label. */
  readonly chipAboutDish: string;
  readonly chipAboutVenue: string;
  readonly chipScan: string;
  readonly removeChip: string;
  readonly changeCity: string;
  /** Find Nearby location entry (plan §14); `{city}` where noted. */
  readonly locationPrompt: string;
  readonly locationExplore: string;
  readonly locationChoose: string;
  readonly locationUseMine: string;
  readonly locationLocating: string;
  readonly locationDenied: string;
  /** Failure and recovery states (plan §18, addendum §7). */
  readonly errorTransport: string;
  readonly errorRateLimited: string;
  readonly errorUnavailable: string;
  readonly errorInvalid: string;
  readonly errorAuth: string;
  readonly errorDisabled: string;
  readonly errorExpiredScan: string;
  readonly errorUnauthorizedScan: string;
  readonly errorProvider: string;
  readonly errorPhotoLarge: string;
  readonly errorPhotoType: string;
  readonly signInAction: string;
  readonly noEvidence: string;
  /** Plate identification result presentation (plan §13). */
  readonly plateCandidates: string;
  readonly confidenceLikely: string;
  readonly confidencePossible: string;
  readonly confidenceTentative: string;
  readonly evidenceLabel: string;
  readonly noneOfThese: string;
  readonly photoShared: string;
  readonly plateFollowExplain: string;
  readonly plateFollowFind: string;
  /** Scan return context actions (plan §15). */
  readonly scanContextTitle: string;
  readonly scanAskMenu: string;
  readonly scanExplainItem: string;
  readonly scanBuildOrder: string;
  readonly scanFindSimilar: string;
  readonly openScanner: string;
  readonly openingScanner: string;
  /** Order guided choice (plan §16). */
  readonly orderGuideTitle: string;
  readonly orderChooseRestaurant: string;
  readonly orderUseScan: string;
  readonly orderFindPlace: string;
  readonly orderOpenScan: string;
  readonly orderScanNote: string;
  readonly followUpsLabel: string;
  readonly copyAnswer: string;
  readonly copiedAnswer: string;
  readonly viewDishLabel: string;
  readonly viewVenueLabel: string;
  readonly findNearbyLabel: string;
  readonly orderHelpLabel: string;
  readonly openMenuLabel: string;
  readonly provenanceCatalog: string;
  readonly provenanceSynthesized: string;
  readonly suggestPlate: string;
  readonly photoGalleryLabel: string;
  readonly photoCameraLabel: string;
  readonly heroGreeting: string;
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
  workspaceTitle: "Ask Muse",
  workspaceTagline: "Your travel-food companion.",
  suggestCity: "What's good to eat in {city}?",
  suggestDish: "Explain a local dish",
  suggestFind: "Find somewhere to eat",
  suggestScan: "Scan a menu",
  suggestOrder: "Help me order",
  composerPlaceholder: "Ask about food…",
  composerFollowUp: "Ask a follow-up…",
  sendAction: "Send",
  youLabel: "You",
  museLabel: "Muse",
  thinkingCatalog: "Muse is checking the dish catalog…",
  thinkingPlaces: "Looking for relevant places…",
  thinkingPhoto: "Reading your photo…",
  chipAboutDish: "About {name}",
  chipAboutVenue: "At {name}",
  chipScan: "Scanned menu",
  removeChip: "Remove",
  changeCity: "Change city",
  locationPrompt: "Where would you like to eat?",
  locationExplore: "Explore food in {city}",
  locationChoose: "Choose a city",
  locationUseMine: "Use my location",
  locationLocating: "Finding the nearest city…",
  locationDenied: "Location is unavailable. Choose a city instead.",
  errorTransport: "The connection dropped. Your message is kept — try again.",
  errorRateLimited: "You've made several requests. Try again shortly.",
  errorUnavailable: "Muse couldn't finish that request. Your chat is kept — try again.",
  errorInvalid: "That answer came back unclear. Try again.",
  errorAuth: "Sign in to continue. Your place in the chat is kept.",
  errorDisabled: "That feature is currently off. Try asking about food instead.",
  errorExpiredScan: "This private scan has expired. Scan the menu again.",
  errorUnauthorizedScan: "This menu isn't available to your account.",
  errorProvider: "Muse couldn't finish that request. Try again.",
  errorPhotoLarge: "This photo is too large. Choose one under 8 MiB.",
  errorPhotoType: "Choose a JPEG, PNG, or WebP photo.",
  signInAction: "Sign in",
  noEvidence: "No catalog evidence for that yet — try another dish or city.",
  plateCandidates: "Tentative matches — confirm with the venue before ordering.",
  confidenceLikely: "Likely",
  confidencePossible: "Possible",
  confidenceTentative: "Tentative",
  evidenceLabel: "What Muse sees",
  noneOfThese: "None of these",
  photoShared: "Shared a food photo for identification.",
  plateFollowExplain: "What is {name}?",
  plateFollowFind: "Find {name} nearby",
  scanContextTitle: "Continue with this scan",
  scanAskMenu: "Ask about this menu",
  scanExplainItem: "Explain a menu item",
  scanBuildOrder: "Build an order",
  scanFindSimilar: "Find similar dishes",
  openScanner: "Open the scanner",
  openingScanner: "Opening the scanner…",
  orderGuideTitle: "What are you ordering from?",
  orderChooseRestaurant: "Choose a restaurant",
  orderUseScan: "Use my scanned menu",
  orderFindPlace: "Find a place nearby",
  orderOpenScan: "Open the scan",
  orderScanNote:
    "Ordering from a scanned menu — prices stay as printed until the venue confirms them.",
  followUpsLabel: "Suggested follow-ups",
  copyAnswer: "Copy answer",
  copiedAnswer: "Copied",
  viewDishLabel: "View dish",
  viewVenueLabel: "View place",
  findNearbyLabel: "Find nearby",
  orderHelpLabel: "Order help",
  openMenuLabel: "Open menu",
  provenanceCatalog: "From the FeastJourney catalog",
  provenanceSynthesized: "Muse answer, grounded in catalog evidence",
  suggestPlate: "Identify a dish from a photo",
  photoGalleryLabel: "Choose a photo",
  photoCameraLabel: "Take a photo",
  heroGreeting: "Hi! I'm Muse ✨",
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
  workspaceTitle: "Hỏi Muse",
  workspaceTagline: "Bạn đồng hành ẩm thực cho chuyến đi.",
  suggestCity: "Món gì ngon ở {city}?",
  suggestDish: "Giải thích một món địa phương",
  suggestFind: "Tìm quán ăn gần đây",
  suggestScan: "Chụp thực đơn",
  suggestOrder: "Nhờ gọi món giúp",
  composerPlaceholder: "Hỏi về món ăn…",
  composerFollowUp: "Hỏi thêm…",
  sendAction: "Gửi",
  youLabel: "Bạn",
  museLabel: "Muse",
  thinkingCatalog: "Muse đang tra danh mục món…",
  thinkingPlaces: "Đang tìm quán phù hợp…",
  thinkingPhoto: "Đang xem ảnh của bạn…",
  chipAboutDish: "Về {name}",
  chipAboutVenue: "Tại {name}",
  chipScan: "Thực đơn đã chụp",
  removeChip: "Gỡ",
  changeCity: "Đổi thành phố",
  locationPrompt: "Bạn muốn ăn ở đâu?",
  locationExplore: "Khám phá món ngon ở {city}",
  locationChoose: "Chọn thành phố",
  locationUseMine: "Dùng vị trí của tôi",
  locationLocating: "Đang tìm thành phố gần nhất…",
  locationDenied: "Không lấy được vị trí. Hãy chọn thành phố nhé.",
  errorTransport: "Mất kết nối. Tin nhắn của bạn vẫn còn — thử lại nhé.",
  errorRateLimited: "Bạn đã gửi nhiều yêu cầu. Thử lại sau một lát.",
  errorUnavailable: "Muse chưa xong yêu cầu này. Đoạn chat vẫn còn — thử lại nhé.",
  errorInvalid: "Câu trả lời chưa rõ ràng. Thử lại nhé.",
  errorAuth: "Đăng nhập để tiếp tục. Vị trí chat của bạn vẫn còn.",
  errorDisabled: "Tính năng này hiện đang tắt. Hãy hỏi về món ăn nhé.",
  errorExpiredScan: "Lần chụp này đã hết hạn. Hãy chụp thực đơn lại.",
  errorUnauthorizedScan: "Thực đơn này không thuộc tài khoản của bạn.",
  errorProvider: "Muse chưa xong yêu cầu này. Thử lại nhé.",
  errorPhotoLarge: "Ảnh này quá lớn. Hãy chọn ảnh dưới 8 MiB.",
  errorPhotoType: "Hãy chọn ảnh JPEG, PNG hoặc WebP.",
  signInAction: "Đăng nhập",
  noEvidence: "Danh mục chưa có món này — thử món hoặc thành phố khác nhé.",
  plateCandidates: "Gợi ý phỏng đoán — hãy xác nhận với quán trước khi gọi món.",
  confidenceLikely: "Khả năng cao",
  confidencePossible: "Có thể",
  confidenceTentative: "Chưa chắc",
  evidenceLabel: "Điểm Muse thấy",
  noneOfThese: "Không phải món nào",
  photoShared: "Đã chia sẻ ảnh món ăn để nhận diện.",
  plateFollowExplain: "{name} là món gì?",
  plateFollowFind: "Tìm {name} ở gần đây",
  scanContextTitle: "Tiếp tục với lần chụp này",
  scanAskMenu: "Hỏi về thực đơn này",
  scanExplainItem: "Giải thích một món",
  scanBuildOrder: "Soạn món gọi",
  scanFindSimilar: "Tìm món tương tự",
  openScanner: "Mở trình quét",
  openingScanner: "Đang mở trình quét…",
  orderGuideTitle: "Bạn gọi món từ đâu?",
  orderChooseRestaurant: "Chọn quán",
  orderUseScan: "Dùng thực đơn đã chụp",
  orderFindPlace: "Tìm quán gần đây",
  orderOpenScan: "Mở lần chụp",
  orderScanNote:
    "Gọi món từ thực đơn đã chụp — giá giữ nguyên như trên ảnh cho đến khi quán xác nhận.",
  followUpsLabel: "Gợi ý tiếp theo",
  copyAnswer: "Chép câu trả lời",
  copiedAnswer: "Đã chép",
  viewDishLabel: "Xem món",
  viewVenueLabel: "Xem quán",
  findNearbyLabel: "Tìm quán gần đây",
  orderHelpLabel: "Nhờ gọi món",
  openMenuLabel: "Mở thực đơn",
  provenanceCatalog: "Từ danh mục FeastJourney",
  provenanceSynthesized: "Muse trả lời, dựa trên danh mục",
  suggestPlate: "Nhận diện món qua ảnh",
  photoGalleryLabel: "Chọn ảnh",
  photoCameraLabel: "Chụp ảnh",
  heroGreeting: "Chào! Mình là Muse ✨",
};

export type CopilotLanguage = "en" | "vi";

/** Reviewed copilot copy; every other locale reads English. */
export const copilotCopyFor = (language: CopilotLanguage): CopilotCopy =>
  language === "vi" ? viCopilotCopy : enCopilotCopy;
