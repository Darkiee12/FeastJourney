import { Data } from "effect";

export class RateLimitExceeded extends Data.TaggedError("RateLimitExceeded")<{
  readonly retryAfterSeconds: number;
  readonly limit: number;
}> {}

export class StoreUnavailable extends Data.TaggedError("StoreUnavailable")<{
  readonly operation: string;
}> {}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export const apiErrorBody = (code: string, message: string, requestId: string): ApiErrorBody => ({
  error: { code, message, requestId },
});

export const troubleByTag = {
  RestaurantInputError: { status: 400, code: "invalid_request" },
  RestaurantNotFound: { status: 404, code: "not_found" },
  UnknownVenue: { status: 404, code: "not_found" },
  CustomerReviewNotFound: { status: 404, code: "not_found" },
  NotReviewAuthor: { status: 403, code: "forbidden" },
  CustomerReviewConflict: { status: 409, code: "conflict" },
  CustomerReviewValidationFailed: { status: 400, code: "invalid_request" },
  RestaurantPhotoNotFound: { status: 404, code: "not_found" },
  RestaurantPhotoValidationFailed: { status: 400, code: "invalid_request" },
  RestaurantPhotoLimitExceeded: { status: 409, code: "conflict" },
  RestaurantPhotoPublishBlocked: { status: 422, code: "invalid_request" },
  RestaurantPhotoConflict: { status: 409, code: "conflict" },
  RestaurantPhotoStorageFailed: { status: 503, code: "unavailable" },
  RestaurantPhotoStorageMisconfigured: { status: 503, code: "unavailable" },
  MenuPageNotFound: { status: 404, code: "not_found" },
  MenuPageValidationFailed: { status: 400, code: "invalid_request" },
  MenuPageLimitExceeded: { status: 409, code: "conflict" },
  MenuPagePublishBlocked: { status: 422, code: "invalid_request" },
  MenuPageConflict: { status: 409, code: "conflict" },
  FxUnavailable: { status: 503, code: "unavailable" },
  ScanNotFound: { status: 404, code: "not_found" },
  ScanConflict: { status: 409, code: "conflict" },
  ScanInputError: { status: 400, code: "invalid_request" },
  InvalidImage: { status: 400, code: "invalid_image" },
  InvalidModelOutput: { status: 422, code: "invalid_extraction" },
  ExtractionUnavailable: { status: 503, code: "unavailable" },
  StorageUnavailable: { status: 503, code: "unavailable" },
  DishNotFound: { status: 404, code: "not_found" },
  IngredientNotFound: { status: 404, code: "not_found" },
  PlaceNotFound: { status: 404, code: "not_found" },
  InvalidSearchFilter: { status: 400, code: "invalid_request" },
  UnknownPlace: { status: 400, code: "invalid_request" },
  AmbiguousPlace: { status: 400, code: "invalid_request" },
  InvalidLocale: { status: 400, code: "invalid_request" },
  InvalidJsonBody: { status: 400, code: "invalid_request" },
  InvalidDishData: { status: 400, code: "invalid_request" },
  InvalidRelationship: { status: 400, code: "invalid_request" },
  ConflictingDish: { status: 409, code: "conflict" },
  CatalogConflict: { status: 409, code: "conflict" },
  PersistenceConflict: { status: 409, code: "conflict" },
  SignInRequired: { status: 401, code: "unauthenticated" },
  AdminRequired: { status: 401, code: "unauthenticated" },
  Forbidden: { status: 403, code: "forbidden" },
  InsufficientPermissions: { status: 403, code: "forbidden" },
  OwnershipDenied: { status: 403, code: "forbidden" },
  UserSuspended: { status: 403, code: "forbidden" },
  RecentAuthenticationRequired: { status: 401, code: "reauthentication_required" },
  RoleNotFound: { status: 404, code: "not_found" },
  ProtectedRole: { status: 403, code: "forbidden" },
  RoleNotManageable: { status: 403, code: "forbidden" },
  LastOwnerRemovalDenied: { status: 409, code: "conflict" },
  UnknownPermission: { status: 400, code: "invalid_request" },
  InvalidRoleAssignment: { status: 400, code: "invalid_request" },
  SessionExpired: { status: 401, code: "unauthenticated" },
  SessionRevoked: { status: 401, code: "unauthenticated" },
  UnlinkDenied: { status: 409, code: "conflict" },
  FavoriteExists: { status: 409, code: "conflict" },
  FavoriteNotFound: { status: 404, code: "not_found" },
  RateLimitExceeded: { status: 429, code: "rate_limited" },
  DatabaseUnavailable: { status: 503, code: "unavailable" },
  PersistenceError: { status: 500, code: "internal" },
  StoreUnavailable: { status: 503, code: "unavailable" },
  TransactionConflict: { status: 503, code: "unavailable" },
  TransactionFailed: { status: 503, code: "unavailable" },
  RequestTimeout: { status: 503, code: "unavailable" },
} as const;

export type TroubleTag = keyof typeof troubleByTag;

const isTroubleTag = (tag: string): tag is TroubleTag => tag in troubleByTag;

export const troubleCodeFor = (tag: string) => {
  if (isTroubleTag(tag)) {
    return troubleByTag[tag];
  }

  return { status: 500, code: "internal" } as const;
};

export type TroubleMapping = ReturnType<typeof troubleCodeFor>;
