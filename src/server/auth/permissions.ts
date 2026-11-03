import { createAccessControl } from "better-auth/plugins/access";

/**
 * Static permission vocabulary. The set of valid `resource:action` keys is
 * defined here once; the database stores which keys are attached to which
 * roles (`role_permissions`) and which roles each user holds (`user_roles`).
 * Unknown keys are rejected at the role-management boundary, so the client
 * can never invent a permission.
 *
 * Better Auth's admin plugin receives a locked-down configuration built from
 * the same vocabulary (see `pluginAccessControl` / `pluginRoles` below):
 * application authorization is evaluated against the database, never against
 * the plugin's static roles.
 */
const statements = {
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
    "manage-roles",
  ],
  session: ["list", "revoke", "delete", "revoke-own", "revoke-any", "list-own", "list-any"],
  favorite: ["create", "read", "delete"],
  profile: ["read", "update"],
  food: ["read", "create", "update", "publish", "import"],
  restaurant: ["read", "submit", "verify", "manage", "review"],
  moderation: ["read", "resolve"],
  support: ["read", "manage"],
  admin: ["access"],
  role: ["create", "read", "update", "delete", "assign", "manage-permissions", "manage-protected"],
  audit: ["read"],
} as const;

export const ac = createAccessControl(statements);

export type Permission = {
  [
    Resource in keyof typeof statements
  ]: `${Resource & string}:${(typeof statements)[Resource][number]}`;
}[keyof typeof statements];

/**
 * A single resource-scoped permission check. The union is derived from the
 * static vocabulary above, so a misspelled resource or action in
 * application code fails typecheck instead of silently denying at
 * runtime. HTTP input arrives as plain strings and is validated with
 * `isPermissionRequest` before it can become one of these.
 */
export type PermissionRequest = {
  [Resource in keyof typeof statements]: {
    readonly resource: Resource;
    readonly actions: ReadonlyArray<(typeof statements)[Resource][number]>;
  };
}[keyof typeof statements];

const collectKeys = (): ReadonlyArray<string> => {
  const keys: Array<string> = [];

  for (const [resource, actions] of Object.entries(statements)) {
    // SAFETY: iterates the fixed statement table above; keys validated by isPermissionKey at input.
    for (const action of actions as ReadonlyArray<string>) {
      keys.push(`${resource}:${action}`);
    }
  }

  return keys;
};

export const PERMISSION_KEYS: ReadonlyArray<string> = collectKeys();

export const isPermissionKey = (value: string): value is Permission =>
  PERMISSION_KEYS.includes(value);

/**
 * Validates untrusted HTTP input as a `PermissionRequest`. A request is
 * valid exactly when every `resource:action` pair names a known permission
 * key — the same condition `Authorization.require` enforces — so anything
 * else fails closed before it can become a typed request.
 */
export const isPermissionRequest = (value: {
  readonly resource: string;
  readonly actions: ReadonlyArray<string>;
}): value is PermissionRequest =>
  value.actions.every((action) => isPermissionKey(`${value.resource}:${action}`));

// Validated at module load: the catalog only ever contains vocabulary keys.
export const SYSTEM_PERMISSIONS: ReadonlyArray<Permission> = collectKeys().filter(isPermissionKey);

/** Stable identifiers of the seeded system roles (see V006). */
export const SYSTEM_ROLES = {
  member: "member",
  curator: "curator",
  moderator: "moderator",
  support: "support",
  admin: "admin",
  owner: "owner",
} as const;

export type SystemRoleId = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/**
 * Locked-down Better Auth admin plugin configuration. Every role carries
 * zero grants and the vocabulary exposes no impersonation, user-management,
 * or role-management actions usable through the plugin: the plugin's
 * `/admin/*` endpoints deny for everyone, including administrators.
 * User management (list/ban/roles/sessions) is implemented behind our own
 * authorization boundary with Reylo queries instead.
 */
const emptyGrants = {
  user: [],
  session: [],
  favorite: [],
  profile: [],
  food: [],
  restaurant: [],
  moderation: [],
  support: [],
  admin: [],
  role: [],
  audit: [],
} as const;

export const pluginAccessControl = createAccessControl(statements);

const pluginEmptyRole = pluginAccessControl.newRole(emptyGrants);

export const pluginRoles = {
  member: pluginEmptyRole,
  curator: pluginEmptyRole,
  moderator: pluginEmptyRole,
  support: pluginEmptyRole,
  admin: pluginEmptyRole,
  owner: pluginEmptyRole,
  user: pluginEmptyRole,
} as const;
