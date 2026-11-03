import { Layer } from "effect";

import { UserAdminServiceLive } from "@/modules/user/server/operations/admin-service";
import { AuthorizationLive } from "@/modules/user/server/operations/authorization";
import { RoleServiceLive } from "@/modules/user/server/operations/role-service";
import { SessionServiceLive } from "@/modules/user/server/operations/session-service";
import {
  FavoritesServiceLive,
  ProfileServiceLive,
} from "@/modules/user/server/operations/user-services";
import { RoleRepositoryLive } from "@/modules/user/server/repository/role-repository";
import { UserRepositoryLive } from "@/modules/user/server/repository/user-repository";

export const UserRepositoriesLive = Layer.mergeAll(RoleRepositoryLive, UserRepositoryLive);

export const UserServicesLive = Layer.mergeAll(
  AuthorizationLive,
  ProfileServiceLive,
  FavoritesServiceLive,
  SessionServiceLive,
  UserAdminServiceLive,
  RoleServiceLive,
);

export { Authorization } from "@/modules/user/server/operations/authorization";

export { FavoritesService, ProfileService } from "@/modules/user/server/operations/user-services";

export { RoleService } from "@/modules/user/server/operations/role-service";

export { SessionService } from "@/modules/user/server/operations/session-service";

export { UserAdminService } from "@/modules/user/server/operations/admin-service";

export { RoleRepository } from "@/modules/user/server/repository/role-repository";

export { UserRepository } from "@/modules/user/server/repository/user-repository";

export type { AdminUserSummary } from "@/modules/user/server/operations/admin-service";

export type { SessionSummary } from "@/modules/user/server/operations/session-service";

export type { RoleSummary } from "@/modules/user/server/operations/role-service";

export { recordAuditEvent } from "@/modules/user/server/operations/audit";

export {
  getPreferredCurrency,
  setPreferredCurrency,
} from "@/modules/user/server/operations/currency-preference";
