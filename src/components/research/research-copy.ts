/**
 * User-facing copy for Muse web research on empty discovery results.
 * English ships the reviewed wording; Vietnamese ships a polished native
 * translation (never machine-translated dietary facts — this copy only
 * describes the research flow and its unverified status).
 */

/** Every user-visible string the research slot and findings list need. */
export interface ResearchCopy {
  readonly statusTitle: string;
  readonly statusSearching: string;
  readonly statusReviewing: string;
  readonly statusCompleted: string;
  readonly statusNoEvidence: string;
  readonly statusFailed: string;
  readonly researchingDishes: string;
  readonly researchingRestaurants: string;
  readonly researchingPrices: string;
  readonly beyondCatalogNote: string;
  readonly viewSources: string;
  readonly researchAction: string;
  readonly retryAction: string;
  readonly continueCatalogAction: string;
  readonly webResultBadge: string;
  readonly notVerifiedNote: string;
}

export const enResearchCopy: ResearchCopy = {
  statusTitle: "Web research with Muse",
  statusSearching: "Searching the web for local dishes…",
  statusReviewing: "Reviewing what the web turned up…",
  statusCompleted: "Here is what the web turned up.",
  statusNoEvidence: "No useful web results for this area yet.",
  statusFailed: "Web research did not finish. Try again when ready.",
  researchingDishes: "Dishes",
  researchingRestaurants: "Places",
  researchingPrices: "Prices",
  beyondCatalogNote: "Goes beyond our catalog, and cites the pages it found.",
  viewSources: "Sources",
  researchAction: "Research with Muse",
  retryAction: "Try research again",
  continueCatalogAction: "Continue with catalog",
  webResultBadge: "Web research",
  notVerifiedNote: "Web research, not verified catalog data. Confirm details before you order.",
};

export const viResearchCopy: ResearchCopy = {
  statusTitle: "Nhờ Muse tìm trên web",
  statusSearching: "Đang tìm món địa phương trên web…",
  statusReviewing: "Đang xem lại kết quả tìm được…",
  statusCompleted: "Đây là những gì tìm được trên web.",
  statusNoEvidence: "Chưa có kết quả web hữu ích cho khu vực này.",
  statusFailed: "Lần tìm trên web chưa xong. Thử lại khi bạn sẵn sàng.",
  researchingDishes: "Món ăn",
  researchingRestaurants: "Quán ăn",
  researchingPrices: "Giá cả",
  beyondCatalogNote: "Tìm vượt ngoài danh mục, kèm trích dẫn trang nguồn.",
  viewSources: "Nguồn",
  researchAction: "Nhờ Muse tìm thêm",
  retryAction: "Thử tìm lại",
  continueCatalogAction: "Xem tiếp danh mục",
  webResultBadge: "Kết quả web",
  notVerifiedNote:
    "Kết quả web, chưa phải dữ liệu danh mục đã kiểm chứng. Hãy xác nhận trước khi gọi món.",
};

/** Research language supported by the web-research server function. */
export type ResearchLanguage = "en" | "vi";

/** Reviewed copy for the research language; every other locale reads English. */
export const researchCopyFor = (language: ResearchLanguage): ResearchCopy =>
  language === "vi" ? viResearchCopy : enResearchCopy;
