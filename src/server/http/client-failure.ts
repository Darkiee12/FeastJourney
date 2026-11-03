import { Predicate } from "effect";

import { troubleCodeFor } from "@/server/http/api-error";
import type { ClientFailure } from "@/shared/client-failure";

/** Explicit disclosure policy. Reasons from infrastructure are never client messages. */
export function clientFailure(cause: unknown): ClientFailure {
  const tag =
    Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag)
      ? cause._tag
      : "InternalError";

  const mapping = troubleCodeFor(tag);
  let message = "Data is temporarily unavailable. Please retry.";

  if (tag === "DishNotFound") message = "This dish is unavailable.";

  if (tag === "RestaurantNotFound" || tag === "UnknownVenue")
    message = "This restaurant is unavailable.";

  if (tag === "CustomerReviewNotFound") message = "This review is unavailable.";

  if (tag === "NotReviewAuthor") message = "You can only change your own review.";

  if (tag === "ScanNotFound") message = "This private scan is unavailable or has expired.";

  if (tag === "RestaurantPhotoNotFound" || tag === "MenuPageNotFound")
    message = "This image is unavailable.";

  if (
    tag === "RestaurantPhotoValidationFailed" ||
    tag === "MenuPageValidationFailed" ||
    tag === "RestaurantPhotoPublishBlocked" ||
    tag === "MenuPagePublishBlocked"
  )
    message = "This image cannot be used yet. Check the requirements and try again.";

  if (tag === "SignInRequired") message = "Sign in to continue.";

  if (tag === "InsufficientPermissions" || tag === "OwnershipDenied")
    message = "You do not have permission for this action.";

  if (tag === "PersistenceConflict" || tag === "ScanConflict" || tag === "CustomerReviewConflict")
    message = "This record changed. Reload before retrying.";

  if (tag === "RateLimitExceeded") message = "Too many requests. Please wait before retrying.";

  if (
    (tag === "RestaurantInputError" ||
      tag === "FxUnavailable" ||
      tag === "InvalidImage" ||
      tag === "InvalidModelOutput" ||
      tag === "CustomerReviewValidationFailed" ||
      tag === "ScanInputError") &&
    Predicate.hasProperty(cause, "reason") &&
    Predicate.isString(cause.reason)
  )
    message = cause.reason;

  if (tag === "ExtractionUnavailable")
    message = "Menu analysis is unavailable. Please retry later.";

  if (tag === "StorageUnavailable") message = "Private photo storage is unavailable. Please retry.";
  let retryAfterSeconds: number | null = null;

  if (
    Predicate.hasProperty(cause, "retryAfterSeconds") &&
    Predicate.isNumber(cause.retryAfterSeconds)
  )
    retryAfterSeconds = cause.retryAfterSeconds;

  const retryable =
    Predicate.hasProperty(cause, "retryable") && Predicate.isBoolean(cause.retryable)
      ? cause.retryable
      : mapping.status === 429 || mapping.status === 503;

  return {
    _tag: tag,
    ...mapping,
    message,
    retryable,
    retryAfterSeconds,
  };
}
