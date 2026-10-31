import { Layer } from "effect";
import type * as PersistenceRateLimiter from "effect/persistence/RateLimiter";

import { CatalogServicesLive, RepositoriesLive } from "@/modules/food-discovery/server/index";
import {
  type AdminDashboardService,
  AdminDashboardServiceLive,
} from "@/modules/food-discovery/server/operations/admin-dashboard-service";
import type { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import { CatalogImportServiceLive } from "@/modules/food-discovery/server/operations/catalog-import-service";
import type { CatalogImportService } from "@/modules/food-discovery/server/operations/catalog-import-service";
import type { CatalogService } from "@/modules/food-discovery/server/operations/catalog-service";
import { CurationServiceLive } from "@/modules/food-discovery/server/operations/curation-service";
import type { CurationService } from "@/modules/food-discovery/server/operations/curation-service";
import type { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import {
  type RecommendationService,
  RecommendationServiceLive,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import type { CurationRepository } from "@/modules/food-discovery/server/repository/curation-repository";
import type { DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import type { DishRepository } from "@/modules/food-discovery/server/repository/dish-repository";
import type { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import type { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import type {
  SourceRepository,
  TaxonomyRepository,
} from "@/modules/food-discovery/server/repository/taxonomy-repository";
import {
  FxRatesLive,
  FxProviderLive,
  type FxRates,
} from "@/modules/restaurant-discovery/server/index";
import type { RestaurantPhotoStorage } from "@/modules/restaurant-discovery/server/integrations/restaurant-photo-storage";
import { RestaurantPhotoFullLive } from "@/modules/restaurant-discovery/server/operations/photos";
import { UserRepositoriesLive, UserServicesLive } from "@/modules/user/server/index";
import type { UserAdminService } from "@/modules/user/server/operations/admin-service";
import type { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleService } from "@/modules/user/server/operations/role-service";
import type { SessionService } from "@/modules/user/server/operations/session-service";
import type {
  FavoritesService,
  ProfileService,
} from "@/modules/user/server/operations/user-services";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { DatabaseLive } from "@/server/database/client";
import type { Database } from "@/server/database/client";
import { RateLimiterLive, RateLimitPolicyLive } from "@/server/http/rate-limit";
import type { RateLimitPolicy } from "@/server/http/rate-limit";
import { MetaClientLive } from "@/server/integrations/meta-client";
import type { MetaClient } from "@/server/integrations/meta-client";
import { MenuExtractorLive, type MenuExtractor } from "@/server/integrations/muse-menu";
import {
  PrivateMenuStorageLive,
  type PrivateMenuStorage,
} from "@/server/integrations/private-menu-storage";

const CurationLive = Layer.provide(CurationServiceLive, RepositoriesLive);
const FxLive = Layer.provide(FxRatesLive, FxProviderLive);

const DomainLive = Layer.provide(
  Layer.mergeAll(CatalogServicesLive, CatalogImportServiceLive),
  Layer.mergeAll(RepositoriesLive, CurationLive),
);

const UserLive = Layer.provide(UserServicesLive, Layer.mergeAll(UserRepositoriesLive, DomainLive));

const DashboardLive = Layer.provide(
  AdminDashboardServiceLive,
  Layer.mergeAll(RepositoriesLive, CurationLive, DomainLive),
);

const RecommendationLive = Layer.provide(
  RecommendationServiceLive,
  Layer.mergeAll(RepositoriesLive, MetaClientLive, DatabaseLive),
);

export const AppLive = Layer.mergeAll(
  DatabaseLive,
  FxLive,
  RateLimiterLive,
  RateLimitPolicyLive,
  RepositoriesLive,
  CurationLive,
  DomainLive,
  DashboardLive,
  UserRepositoriesLive,
  UserLive,
  MetaClientLive,
  RecommendationLive,
  MenuExtractorLive,
  PrivateMenuStorageLive,
  RestaurantPhotoFullLive,
);

export type AppServices =
  | MenuExtractor
  | PrivateMenuStorage
  | RestaurantPhotoStorage
  | FxRates
  | Database
  | PersistenceRateLimiter.RateLimiter
  | RateLimitPolicy
  | DishRepository
  | DishRelationsRepository
  | IngredientRepository
  | PlaceRepository
  | TaxonomyRepository
  | SourceRepository
  | DishService
  | CatalogService
  | AdminService
  | CatalogImportService
  | AdminDashboardService
  | CurationService
  | RecommendationService
  | MetaClient
  | CurationRepository
  | UserRepository
  | RoleRepository
  | Authorization
  | ProfileService
  | FavoritesService
  | SessionService
  | UserAdminService
  | RoleService;
