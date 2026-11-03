/**
 * Server-independent customer-review constants. Browser schemas, forms, and
 * server operations import from here so no client bundle pulls server
 * dependencies for a shared bound.
 */
export const CUSTOMER_REVIEW_BODY_MAX = 2000;

export const CUSTOMER_REVIEW_PAGE_MAX = 50;

export const CUSTOMER_REVIEW_SORT_MODES = ["recent", "highest", "lowest"] as const;

export type CustomerReviewSortMode = (typeof CUSTOMER_REVIEW_SORT_MODES)[number];
