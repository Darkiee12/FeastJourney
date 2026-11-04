import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { useId, useState } from "react";

import { parseCommaList, tooLongTerms } from "@/components/home/recommend/quiz-model";
import { PersonalNav } from "@/components/personal-nav";
import { signOutFn } from "@/modules/user/auth.functions";
import { ExcludedIngredientsField } from "@/modules/user/components/excluded-ingredients-field";
import {
  getFoodPreferencesFn,
  getProfileFn,
  saveFoodPreferencesFn,
  updateProfileFn,
} from "@/modules/user/profile.functions";
import { listAccountsFn, unlinkAccountFn } from "@/modules/user/session.functions";
import {
  messagesFor,
  displayLocales,
  locales,
  localeNameFor,
  bcp47TagFor,
  markLocaleExplicit,
  writeLocaleCookie,
} from "@/shared/i18n";
import type { Locale } from "@/shared/i18n";

const isLocale = (value: string): value is Locale =>
  // SAFETY: narrows free-form UI input against the fixed locale vocabulary.
  (locales as ReadonlyArray<string>).includes(value);

const isDisplayLocale = (value: string): value is Locale =>
  // SAFETY: narrows free-form UI input against the advertised display locales.
  (displayLocales as ReadonlyArray<string>).includes(value);

const rootRoute = getRouteApi("__root__");

type AccountContext =
  | {
      readonly user: { readonly id: string; readonly name: string; readonly email: string };
      readonly unavailable: false;
    }
  | { readonly user: null; readonly unavailable: true };

const resolveInitialLocale = (stored: string, fallback: string): Locale => {
  if (isDisplayLocale(stored)) {
    return stored;
  }

  if (isLocale(fallback)) {
    return fallback;
  }

  return "en";
};

export const Route = createFileRoute("/settings/account")({
  beforeLoad: async ({ context, search }): Promise<AccountContext> => {
    if (context.session.status === "signed-out") {
      throw redirect({
        to: "/sign-in",
        search: { returnTo: "/settings/account", lang: search.lang },
      });
    }

    if (context.session.status === "unavailable") {
      return { user: null, unavailable: true };
    }

    return { user: context.session.user, unavailable: false };
  },
  loader: async ({ context }) => {
    if (context.unavailable) {
      // SAFETY: literal unavailable marker for the component's discriminated
      // union branch; no untrusted input is asserted.
      return { profile: null, accounts: [], unavailable: true } as const;
    }

    const [profile, linked, foodPreferences] = await Promise.all([
      getProfileFn(),
      listAccountsFn(),
      getFoodPreferencesFn(),
    ]);

    // SAFETY: literal loaded marker for the component's discriminated union
    // branch; row shapes come from Reylo-inferred server functions.
    return { profile, accounts: linked.accounts, foodPreferences, unavailable: false } as const;
  },
  component: AccountSettings,
});

const inputClass =
  "mt-1 w-full min-w-0 rounded-md border border-border-soft bg-white px-3 py-2 text-base text-ink motion-safe:transition-colors focus:border-brand-blue";

function AccountSettings() {
  const { lang } = rootRoute.useSearch();
  const routeContext = Route.useRouteContext();
  const loaderData = Route.useLoaderData();
  const copy = messagesFor(lang);
  const formId = useId();

  const unavailable = routeContext.unavailable;

  const fallbackUserName = routeContext.user?.name ?? "";
  const fallbackProfile = loaderData.profile;
  const fallbackAccounts = loaderData.accounts;
  const fallbackFoodPreferences = loaderData.foodPreferences;

  const nameId = `${formId}-display-name`;
  const localeId = `${formId}-locale`;
  const excludedId = `${formId}-excluded`;
  const saveErrorId = `${formId}-save-error`;
  const foodPrefsErrorId = `${formId}-food-prefs-error`;
  const unlinkErrorId = `${formId}-unlink-error`;
  const signOutErrorId = `${formId}-signout-error`;

  const [displayName, setDisplayName] = useState(fallbackProfile?.display_name ?? fallbackUserName);

  const initialLocale = fallbackProfile?.locale ?? "";

  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale(initialLocale, lang));

  const [excludedRaw, setExcludedRaw] = useState(
    fallbackFoodPreferences?.excludedIngredients.join(", ") ?? "",
  );

  const [foodPrefsLocalError, setFoodPrefsLocalError] = useState<string | null>(null);

  const [accounts, setAccounts] = useState(fallbackAccounts);

  const [unlinkTarget, setUnlinkTarget] = useState<string | null>(null);

  const saveProfile = useMutation({
    mutationFn: (input: { displayName: string | null; locale: Locale }) =>
      updateProfileFn({
        data: { display_name: input.displayName, locale: input.locale },
      }),
    onSuccess: (_data, input) => {
      // The saved account language is an explicit preference: persist it
      // where both the server (cookie) and the client (explicit flag) honor
      // it, so auto-detect never overrides it on the next visit.
      markLocaleExplicit();
      writeLocaleCookie(input.locale);
    },
  });

  const unlink = useMutation({
    mutationFn: (accountId: string) => unlinkAccountFn({ data: { account_id: accountId } }),
    onSuccess: (_data, accountId) => {
      setAccounts(accounts.filter((other) => other.accountId !== accountId));
      setUnlinkTarget(null);
    },
  });

  const queryClient = useQueryClient();

  const saveFoodPrefs = useMutation({
    mutationFn: (input: { excluded: Array<string> }) =>
      saveFoodPreferencesFn({ data: { excluded_ingredients: input.excluded } }),
    onSuccess: (_data, input) => {
      setFoodPrefsLocalError(null);
      // The quiz reads the same account-scoped cache: refresh it so a
      // later quiz visit (or Skip) observes the settings-side save instead
      // of a stale list. Guest localStorage is untouched — the two sources
      // stay independent.
      queryClient.setQueryData(
        ["user", "food-preferences", routeContext.user?.id ?? "signed-out"],
        {
          excludedIngredients: [...input.excluded],
        },
      );
    },
  });

  const signOut = useMutation({
    mutationFn: () => signOutFn(),
    onSuccess: () => {
      window.location.assign("/");
    },
  });

  if (unavailable) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <h1 className="font-display text-4xl tracking-wide">{copy.authAccount}</h1>
        <div className="mt-4">
          <PersonalNav />
        </div>

        <p
          role="note"
          className="mt-4 rounded-lg border border-mango/40 bg-cream px-4 py-3 text-sm font-semibold text-ink"
        >
          Sign-in status is unavailable — we did not sign you out. Try again shortly.
        </p>
      </div>
    );
  }

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    saveProfile.mutate({ displayName, locale });
  };

  const saveFood = (event: React.FormEvent): void => {
    event.preventDefault();

    if (saveFoodPrefs.isPending) {
      return;
    }

    // Client mirror of the server 100-char cap: flag locally so the typed
    // input is preserved; anything else surfaces as a server 400 below.
    const terms = parseCommaList(excludedRaw);

    if (tooLongTerms(terms)) {
      setFoodPrefsLocalError(copy.recTermTooLong);

      return;
    }

    setFoodPrefsLocalError(null);

    if (saveFoodPrefs.isError) {
      saveFoodPrefs.reset();
    }

    saveFoodPrefs.mutate({ excluded: terms });
  };

  const unlinkEntry = accounts.find((entry) => entry.accountId === unlinkTarget) ?? null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="font-display text-4xl tracking-wide">{copy.authAccount}</h1>
      <div className="mt-4">
        <PersonalNav />
      </div>
      <section
        aria-labelledby={`${formId}-profile-heading`}
        className="mt-6 rounded-lg border border-border-soft bg-white p-6 shadow-sm"
      >
        <h2 id={`${formId}-profile-heading`} className="font-display text-2xl tracking-wide">
          {copy.authProfile}
        </h2>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            save(event);
          }}
        >
          <div>
            <label htmlFor={nameId} className="block text-sm font-medium">
              {copy.authDisplayName}
            </label>
            <input
              id={nameId}
              name="displayName"
              type="text"
              autoComplete="name"
              spellCheck={false}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={localeId} className="block text-sm font-medium">
              {copy.authLanguage}
            </label>
            <select
              id={localeId}
              name="locale"
              value={locale}
              onChange={(event) => {
                const next = event.target.value;

                setLocale(isLocale(next) ? next : "en");
              }}
              className={inputClass}
            >
              {displayLocales.map((option) => (
                <option key={option} value={option} lang={bcp47TagFor(option)}>
                  {localeNameFor(option)}
                </option>
              ))}
            </select>
          </div>
          {saveProfile.isError ? (
            <div
              role="alert"
              id={saveErrorId}
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              <p>{copy.settingsSaveFailed}</p>
              <button
                type="button"
                className="mt-2 font-medium underline hover:no-underline"
                onClick={() => {
                  saveProfile.reset();
                }}
              >
                {copy.commonRetry}
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saveProfile.isPending}
              aria-busy={saveProfile.isPending}
              aria-describedby={saveProfile.isError ? saveErrorId : undefined}
              className="inline-flex items-center justify-center rounded-md bg-brand-blue px-4 py-2 text-sm font-semibold text-white hover:bg-brand-blue-hover disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
            >
              {saveProfile.isPending ? copy.settingsSaving : copy.authSave}
            </button>
            {saveProfile.isSuccess ? (
              <output className="text-sm text-green-800">{copy.authSaved}</output>
            ) : null}
          </div>
        </form>
      </section>
      <section
        aria-label={copy.recExcludedLabel}
        className="mt-6 rounded-lg border border-border-soft bg-white p-6 shadow-sm"
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            saveFood(event);
          }}
        >
          <ExcludedIngredientsField
            compact
            copy={copy}
            disabled={saveFoodPrefs.isPending}
            id={excludedId}
            onChange={setExcludedRaw}
            value={excludedRaw}
          />
          {foodPrefsLocalError !== null ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              <p>{foodPrefsLocalError}</p>
            </div>
          ) : null}
          {saveFoodPrefs.isError ? (
            <div
              role="alert"
              id={foodPrefsErrorId}
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              <p>{copy.settingsSaveFailed}</p>
              <button
                type="button"
                className="mt-2 font-medium underline hover:no-underline"
                onClick={() => {
                  saveFoodPrefs.reset();
                }}
              >
                {copy.commonRetry}
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saveFoodPrefs.isPending}
              aria-busy={saveFoodPrefs.isPending}
              aria-describedby={saveFoodPrefs.isError ? foodPrefsErrorId : undefined}
              className="inline-flex items-center justify-center rounded-md bg-brand-blue px-4 py-2 text-sm font-semibold text-white hover:bg-brand-blue-hover disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
            >
              {saveFoodPrefs.isPending ? copy.settingsSaving : copy.authSave}
            </button>
            {saveFoodPrefs.isSuccess ? (
              <output className="text-sm text-green-800">{copy.authSaved}</output>
            ) : null}
          </div>
        </form>
      </section>
      <section
        aria-labelledby={`${formId}-linked-heading`}
        className="mt-6 rounded-lg border border-border-soft bg-white p-6 shadow-sm"
      >
        <h2 id={`${formId}-linked-heading`} className="font-display text-2xl tracking-wide">
          {copy.authLinked}
        </h2>
        {accounts.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{copy.settingsNoLinked}</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {accounts.map((entry) => (
              <li
                key={entry.accountId}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft px-3 py-2"
              >
                <span className="min-w-0 break-words text-sm">{entry.providerId}</span>
                <button
                  type="button"
                  disabled={unlink.isPending}
                  aria-busy={unlink.isPending}
                  onClick={() => {
                    setUnlinkTarget(entry.accountId);
                  }}
                  className="inline-flex items-center justify-center rounded-md border border-border-soft bg-white px-3 py-1.5 text-sm font-medium hover:bg-cream disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
                >
                  {copy.authUnlink}
                </button>
              </li>
            ))}
          </ul>
        )}
        {unlinkEntry !== null ? (
          <div
            role="alert"
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            <p>
              {accounts.length === 1 ? copy.settingsUnlinkLastConfirm : copy.settingsUnlinkConfirm}{" "}
              <span className="break-words font-medium">{unlinkEntry.providerId}</span>
            </p>
            <p className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={unlink.isPending}
                onClick={() => {
                  unlink.mutate(unlinkEntry.accountId);
                }}
                className="inline-flex items-center justify-center rounded-md bg-brand-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-blue-hover disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
              >
                {copy.commonConfirm}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUnlinkTarget(null);
                }}
                className="inline-flex items-center justify-center rounded-md border border-border-soft bg-white px-3 py-1.5 text-sm font-medium hover:bg-cream motion-safe:transition-colors"
              >
                {copy.commonCancel}
              </button>
            </p>
          </div>
        ) : null}
        {unlink.isError ? (
          <div
            role="alert"
            id={unlinkErrorId}
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            <p>{copy.settingsUnlinkFailed}</p>
            <button
              type="button"
              className="mt-2 font-medium underline hover:no-underline"
              onClick={() => {
                unlink.reset();
              }}
            >
              {copy.commonRetry}
            </button>
          </div>
        ) : null}
      </section>
      <section
        aria-labelledby={`${formId}-signout-heading`}
        className="mt-6 rounded-lg border border-border-soft bg-white p-6 shadow-sm"
      >
        <h2 id={`${formId}-signout-heading`} className="font-display text-2xl tracking-wide">
          {copy.authSignOut}
        </h2>
        {signOut.isError ? (
          <div
            role="alert"
            id={signOutErrorId}
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            <p>{copy.settingsSignOutFailed}</p>
          </div>
        ) : null}
        <button
          type="button"
          disabled={signOut.isPending}
          aria-busy={signOut.isPending}
          aria-describedby={signOut.isError ? signOutErrorId : undefined}
          onClick={() => {
            if (signOut.isError) {
              signOut.reset();
            }

            signOut.mutate();
          }}
          className="mt-3 inline-flex items-center justify-center rounded-md border border-border-soft bg-white px-4 py-2 text-sm font-medium hover:bg-cream disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
        >
          {signOut.isPending ? copy.settingsSigningOut : copy.authSignOut}
        </button>
      </section>
    </div>
  );
}
