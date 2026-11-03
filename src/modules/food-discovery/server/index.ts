import { Layer } from "effect";

import {
  AdminService,
  AdminServiceLive,
} from "@/modules/food-discovery/server/operations/admin-service";
import {
  CatalogService,
  CatalogServiceLive,
} from "@/modules/food-discovery/server/operations/catalog-service";
import {
  DishService,
  DishServiceLive,
} from "@/modules/food-discovery/server/operations/dish-service";
import {
  CurationRepository,
  CurationRepositoryLive,
} from "@/modules/food-discovery/server/repository/curation-repository";
import {
  DishRelationsRepository,
  DishRelationsRepositoryLive,
} from "@/modules/food-discovery/server/repository/dish-relations-repository";
import {
  DishRepository,
  DishRepositoryLive,
} from "@/modules/food-discovery/server/repository/dish-repository";
import {
  IngredientRepository,
  IngredientRepositoryLive,
} from "@/modules/food-discovery/server/repository/ingredient-repository";
import {
  PlaceRepository,
  PlaceRepositoryLive,
} from "@/modules/food-discovery/server/repository/place-repository";
import {
  SourceRepository,
  SourceRepositoryLive,
  TaxonomyRepository,
  TaxonomyRepositoryLive,
} from "@/modules/food-discovery/server/repository/taxonomy-repository";

export const RepositoriesLive = Layer.mergeAll(
  CurationRepositoryLive,
  DishRepositoryLive,
  DishRelationsRepositoryLive,
  IngredientRepositoryLive,
  PlaceRepositoryLive,
  TaxonomyRepositoryLive,
  SourceRepositoryLive,
);

export const CatalogServicesLive = Layer.mergeAll(
  DishServiceLive,
  CatalogServiceLive,
  AdminServiceLive,
);

export { CatalogImportService } from "@/modules/food-discovery/server/operations/catalog-import-service";

export { getPublishedDishIdentities } from "@/modules/food-discovery/server/operations/published-identities";

export { AdminDashboardService } from "@/modules/food-discovery/server/operations/admin-dashboard-service";

export { CurationService } from "@/modules/food-discovery/server/operations/curation-service";

export {
  AdminService,
  CatalogService,
  CurationRepository,
  DishService,
  DishRepository,
  DishRelationsRepository,
  IngredientRepository,
  PlaceRepository,
  SourceRepository,
  TaxonomyRepository,
};
