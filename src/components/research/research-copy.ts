import type { Locale } from "@/shared/i18n";

/**
 * User-facing copy for Muse web research on empty discovery results.
 * English and Vietnamese ship reviewed wording; Hindi, Spanish, Chinese,
 * Japanese, German, and Dutch ship complete translations pending
 * native-speaker review (never machine-translated dietary facts — this copy
 * only describes the research flow and its unverified status).
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

export const hiResearchCopy: ResearchCopy = {
  statusTitle: "Muse से वेब खोज",
  statusSearching: "स्थानीय व्यंजन वेब पर खोजे जा रहे हैं…",
  statusReviewing: "मिले परिणाम देखे जा रहे हैं…",
  statusCompleted: "वेब पर यह मिला है।",
  statusNoEvidence: "इस क्षेत्र के लिए वेब पर कोई उपयोगी परिणाम नहीं है।",
  statusFailed: "वेब खोज पूरी नहीं हो सकी। तैयार होने पर फिर से कोशिश करें।",
  researchingDishes: "व्यंजन",
  researchingRestaurants: "जगहें",
  researchingPrices: "कीमतें",
  beyondCatalogNote: "सूची से आगे जाकर, मिले पेजों का हवाला देता है।",
  viewSources: "स्रोत",
  researchAction: "Muse से खोजें",
  retryAction: "फिर से खोजें",
  continueCatalogAction: "सूची से जारी रखें",
  webResultBadge: "वेब खोज",
  notVerifiedNote: "वेब खोज, सत्यापित सूची डेटा नहीं है। ऑर्डर से पहले पुष्टि करें।",
};

export const esResearchCopy: ResearchCopy = {
  statusTitle: "Búsqueda web con Muse",
  statusSearching: "Buscando platos locales en la web…",
  statusReviewing: "Revisando lo que encontró la web…",
  statusCompleted: "Esto es lo que encontró la web.",
  statusNoEvidence: "Sin resultados web útiles para esta zona.",
  statusFailed: "La búsqueda web no terminó. Inténtalo cuando estés listo.",
  researchingDishes: "Platos",
  researchingRestaurants: "Lugares",
  researchingPrices: "Precios",
  beyondCatalogNote: "Va más allá del catálogo y cita las páginas encontradas.",
  viewSources: "Fuentes",
  researchAction: "Investigar con Muse",
  retryAction: "Reintentar búsqueda",
  continueCatalogAction: "Seguir con el catálogo",
  webResultBadge: "Búsqueda web",
  notVerifiedNote: "Búsqueda web, no datos verificados del catálogo. Confirma antes de pedir.",
};

export const zhResearchCopy: ResearchCopy = {
  statusTitle: "用 Muse 做网络搜索",
  statusSearching: "正在网上搜索当地菜品…",
  statusReviewing: "正在查看网上找到的内容…",
  statusCompleted: "这是网上找到的内容。",
  statusNoEvidence: "该地区暂无有用的网络结果。",
  statusFailed: "网络搜索未完成，准备好后重试。",
  researchingDishes: "菜品",
  researchingRestaurants: "店铺",
  researchingPrices: "价格",
  beyondCatalogNote: "超出目录范围，并引用找到的页面。",
  viewSources: "来源",
  researchAction: "用 Muse 搜索",
  retryAction: "重新搜索",
  continueCatalogAction: "继续看目录",
  webResultBadge: "网络搜索",
  notVerifiedNote: "网络搜索，非核实的目录数据。下单前请确认。",
};

export const jaResearchCopy: ResearchCopy = {
  statusTitle: "Muse でウェブ検索",
  statusSearching: "地元料理をウェブで検索中…",
  statusReviewing: "見つけた内容を確認中…",
  statusCompleted: "ウェブで見つけた内容はこちらです。",
  statusNoEvidence: "この地域に有用なウェブ結果はありません。",
  statusFailed: "ウェブ検索が終わりませんでした。準備ができたら再試行してください。",
  researchingDishes: "料理",
  researchingRestaurants: "店",
  researchingPrices: "価格",
  beyondCatalogNote: "カタログを超えて、見つけたページを引用します。",
  viewSources: "出典",
  researchAction: "Muse で調べる",
  retryAction: "再検索",
  continueCatalogAction: "カタログを続ける",
  webResultBadge: "ウェブ検索",
  notVerifiedNote:
    "ウェブ検索であり、検証済みカタログデータではありません。注文前に確認してください。",
};

export const deResearchCopy: ResearchCopy = {
  statusTitle: "Websuche mit Muse",
  statusSearching: "Suche lokale Gerichte im Web…",
  statusReviewing: "Schaue an, was das Web ergab…",
  statusCompleted: "Das hat das Web ergeben.",
  statusNoEvidence: "Keine nützlichen Webergebnisse für diese Gegend.",
  statusFailed: "Websuche hat nicht geklappt. Versuch es, wenn du bereit bist.",
  researchingDishes: "Gerichte",
  researchingRestaurants: "Orte",
  researchingPrices: "Preise",
  beyondCatalogNote: "Geht über den Katalog hinaus und zitiert die gefundenen Seiten.",
  viewSources: "Quellen",
  researchAction: "Mit Muse recherchieren",
  retryAction: "Suche wiederholen",
  continueCatalogAction: "Mit Katalog fortfahren",
  webResultBadge: "Websuche",
  notVerifiedNote: "Websuche, keine verifizierten Katalogdaten. Bestätige vor dem Bestellen.",
};

export const nlResearchCopy: ResearchCopy = {
  statusTitle: "Webonderzoek met Muse",
  statusSearching: "Lokale gerechten op het web zoeken…",
  statusReviewing: "Bekijken wat het web opleverde…",
  statusCompleted: "Dit leverde het web op.",
  statusNoEvidence: "Geen nuttige webresultaten voor dit gebied.",
  statusFailed: "Webonderzoek is niet gelukt. Probeer het als je er klaar voor bent.",
  researchingDishes: "Gerechten",
  researchingRestaurants: "Plekken",
  researchingPrices: "Prijzen",
  beyondCatalogNote: "Gaat verder dan de catalogus en citeert de gevonden pagina's.",
  viewSources: "Bronnen",
  researchAction: "Onderzoek met Muse",
  retryAction: "Opnieuw onderzoeken",
  continueCatalogAction: "Doorgaan met catalogus",
  webResultBadge: "Webonderzoek",
  notVerifiedNote: "Webonderzoek, geen geverifieerde catalogusgegevens. Bevestig voor je bestelt.",
};

/** Research language supported by the web-research server function. */
export type ResearchLanguage = Locale;

const researchCopies: ReadonlyMap<Locale, ResearchCopy> = new Map<Locale, ResearchCopy>([
  ["en", enResearchCopy],
  ["vi", viResearchCopy],
  ["hi", hiResearchCopy],
  ["es", esResearchCopy],
  ["zh", zhResearchCopy],
  ["ja", jaResearchCopy],
  ["de", deResearchCopy],
  ["nl", nlResearchCopy],
]);

/** Reviewed en/vi copy; hi/es/zh/ja/de/nl ship complete translations pending native-speaker review. Every other locale reads English. */
export const researchCopyFor = (language: Locale): ResearchCopy =>
  researchCopies.get(language) ?? enResearchCopy;
