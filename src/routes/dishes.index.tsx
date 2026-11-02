import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { searchDishesFn } from "@/modules/food-discovery/food.functions";
import { DiscoveryError } from "@/modules/restaurant-discovery/components/discovery-error";

export const Route = createFileRoute("/dishes/")({
  validateSearch: z.object({
    q: z.string().max(200).default(""),
    cursor: z.string().max(500).optional(),
  }),
  loaderDeps: ({ search }) => ({ q: search.q, cursor: search.cursor, locale: search.lang }),
  loader: ({ deps }) => searchDishesFn({ data: { ...deps, limit: 30 } }),
  errorComponent: DiscoveryError,
  component: DishSearch,
});

function DishSearch() {
  const search = Route.useSearch();
  const data = Route.useLoaderData();
  const navigate = Route.useNavigate();

  return (
    <section className="discovery-page">
      <nav aria-label="Discover">
        <Link to="/dishes" search={{ lang: search.lang }}>
          Explore dishes
        </Link>
        <Link to="/restaurants" search={{ lang: search.lang }}>
          Find restaurants
        </Link>
      </nav>
      <header>
        <p className="discovery-eyebrow">What should I eat?</p>
        <h1>Explore dishes</h1>
        <p>Meet a dish, learn its story, then find a sourced menu offering.</p>
      </header>
      <form
        className="discovery-search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = z.string().max(200).safeParse(new FormData(event.currentTarget).get("q"));

          if (parsed.success) void navigate({ search: { lang: search.lang, q: parsed.data } });
        }}
      >
        <label htmlFor="dish-query">Dish name</label>
        <input id="dish-query" name="q" type="search" defaultValue={search.q} maxLength={200} />
        <button type="submit">Search dishes</button>
      </form>
      {data.items.length === 0 && (
        <div className="discovery-empty" aria-live="polite">
          <h2>No dishes found</h2>
          <p>Try another name or clear the search.</p>
        </div>
      )}
      <ul className="dish-discovery-grid">
        {data.items.map((dish) => (
          <li key={dish.id} className="discovery-card">
            <h2>
              <Link
                to="/dishes/$dishId"
                params={{ dishId: dish.slug }}
                search={{ lang: search.lang }}
              >
                {dish.name ?? dish.englishName ?? dish.slug}
              </Link>
            </h2>
            <p>{dish.regionNames.join(" · ")}</p>
            <Link
              to="/restaurants"
              search={{ lang: search.lang, dish: dish.id, fromDish: dish.slug }}
            >
              Find restaurants serving this
            </Link>
          </li>
        ))}
      </ul>
      {data.nextCursor !== null && (
        <Link
          className="discovery-action"
          to="/dishes"
          search={{ ...search, cursor: data.nextCursor }}
        >
          Next dishes
        </Link>
      )}
    </section>
  );
}
