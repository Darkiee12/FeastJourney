import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { listCountriesFn, searchCitiesFn } from "@/modules/food-discovery/food.functions";

/** Public registry-backed chooser. A city must belong to the selected country. */
export function ScanResearchLocation({
  locale,
  city,
  country,
  onChange,
}: {
  readonly locale: "en" | "vi";
  readonly city: string;
  readonly country: string;
  readonly onChange: (city: string, country: string, cityId?: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [countryQuery, setCountryQuery] = useState("");
  const [cityQuery, setCityQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [choosingCountry, setChoosingCountry] = useState(country === "");

  const countries = useQuery({
    queryKey: ["catalog", "countries", locale],
    queryFn: () => listCountriesFn({ data: { locale, limit: 250 } }),
    staleTime: 300000,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(cityQuery), 250);

    return () => window.clearTimeout(timer);
  }, [cityQuery]);

  const cities = useQuery({
    queryKey: ["catalog", "cities", locale, debounced],
    queryFn: () => searchCitiesFn({ data: { q: debounced, locale, limit: 50 } }),
    enabled: debounced.trim().length >= 2,
    staleTime: 300000,
  });

  const visibleCities = (cities.data ?? []).filter((entry) => entry.country === country);
  let switchLabel = locale === "vi" ? "Đổi quốc gia" : "Change country";

  if (choosingCountry) switchLabel = locale === "vi" ? "Chọn thành phố" : "Choose city";

  return (
    <div className="scan-research-location">
      <button type="button" className="menu-order-back" onClick={() => dialog.current?.showModal()}>
        {city || (locale === "vi" ? "Chọn thành phố" : "Choose city")} ·{" "}
        {country || (locale === "vi" ? "Quốc gia" : "Country")}
      </button>
      <dialog
        ref={dialog}
        className="menu-waiter-dialog"
        aria-label={locale === "vi" ? "Vị trí thực đơn" : "Menu location"}
      >
        <form method="dialog">
          <button className="menu-order-back">{locale === "vi" ? "Đóng" : "Close"}</button>
        </form>
        <h2 className="font-display text-2xl">
          {locale === "vi" ? "Vị trí thực đơn" : "Menu location"}
        </h2>
        <button
          type="button"
          className="menu-order-back"
          onClick={() => setChoosingCountry(!choosingCountry)}
        >
          {switchLabel}
        </button>
        {choosingCountry ? (
          <>
            <label>
              {locale === "vi" ? "Tìm quốc gia" : "Search countries"}
              <input
                type="search"
                value={countryQuery}
                onChange={(event) => setCountryQuery(event.target.value)}
              />
            </label>
            {countries.isPending && <output>Loading…</output>}
            {countries.isError && (
              <p role="alert">
                Could not load countries.{" "}
                <button
                  type="button"
                  onClick={() => {
                    void countries.refetch();
                  }}
                >
                  Retry
                </button>
              </p>
            )}
            <ul className="scan-place-options">
              {(countries.data ?? [])
                .filter((entry) =>
                  `${entry.displayName ?? ""} ${entry.iso3166 ?? ""}`
                    .toLocaleLowerCase()
                    .includes(countryQuery.toLocaleLowerCase()),
                )
                .map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-pressed={country === entry.iso3166}
                      onClick={() => {
                        if (entry.iso3166 !== null) {
                          onChange("", entry.iso3166);
                          setChoosingCountry(false);
                        }
                      }}
                    >
                      {entry.displayName} · {entry.iso3166}
                    </button>
                  </li>
                ))}
            </ul>
          </>
        ) : (
          <>
            <label>
              {locale === "vi"
                ? "Tìm thành phố trong quốc gia đã chọn"
                : "Search cities in selected country"}
              <input
                type="search"
                disabled={country === ""}
                value={cityQuery}
                onChange={(event) => setCityQuery(event.target.value)}
              />
            </label>
            {cities.isFetching && <output>Searching…</output>}
            {cities.isError && <p role="alert">Could not search cities.</p>}
            {cities.isSuccess && visibleCities.length === 0 && (
              <output>No matching cities in this country.</output>
            )}
            <ul className="scan-place-options">
              {visibleCities.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(
                        entry.name ?? entry.context ?? entry.id,
                        country,
                        `place:${entry.id}`,
                      );
                      dialog.current?.close();
                    }}
                  >
                    {entry.name} · {entry.context}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </dialog>
    </div>
  );
}
