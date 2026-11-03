import identities from "@/modules/food-discovery/server/repository/sql/dish-published-identities.sql";
import { runQuery } from "@/server/database/query";

/** Public, read-only batch identity contract for menus; publication is checked at read time. */
export const getPublishedDishIdentities = (ids: ReadonlyArray<string>) =>
  runQuery("food/published-identities", (sql) => identities.run(sql, { ids: ids.map(BigInt) }));
