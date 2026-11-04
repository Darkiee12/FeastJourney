import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  deriveSlug,
  isValidSlug,
  parseCuisineBulkLine,
  resolveCuisineRowStatuses,
  type BulkCuisineEntry,
  type BulkCuisineResult,
  type TaxonomyClient,
} from "@/components/admin/taxonomy/taxonomy-contracts";
import { BulkResultList, TaxonomySearchField } from "@/components/admin/taxonomy/taxonomy-shared";
import {
  AdminCard,
  AdminEmptyState,
  AdminErrorState,
  AdminField,
  AdminGhostButton,
  AdminPrimaryButton,
  AdminSection,
  AdminSkeleton,
  AdminTable,
  AdminToolbar,
} from "@/components/admin/ui";
import {
  GlobalNotification,
  type GlobalNotificationVariant,
} from "@/components/ui/global-notification";
import type { Locale } from "@/shared/i18n";

const PAGE_SIZE = 50;

export function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}

interface Notice {
  readonly variant: GlobalNotificationVariant;
  readonly title: string;
  readonly description: string;
}

/**
 * Cuisines tab: searchable list, single-add with live slug derivation plus
 * validity hint, and bulk-add (one `slug | Display Name` line each) with
 * per-row created/skipped/invalid outcomes.
 *
 * Server calls go through the injected `client` (React Query for reads,
 * direct awaits for writes, invalidating on success) so tests inject fakes
 * and the merge swaps in the real `*Fn` wiring without touching this file.
 */
export function CuisinePanel({
  client,
  lang,
}: {
  readonly client: TaxonomyClient;
  readonly lang: Locale;
}): ReactNode {
  const vi = lang === "vi";
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const debouncedQuery = useDebouncedValue(query, 300);
  const trimmedQuery = debouncedQuery.trim();

  const listQuery = useQuery({
    queryKey: ["admin", "taxonomy", "cuisines", trimmedQuery],
    queryFn: () =>
      client.listCuisines({
        query: trimmedQuery === "" ? undefined : trimmedQuery,
        limit: PAGE_SIZE,
        offset: 0,
      }),
    staleTime: 15_000,
    retry: 1,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "taxonomy", "cuisines"] });
  };

  const cuisines = useMemo(() => listQuery.data?.cuisines ?? [], [listQuery.data]);
  const emptyMessage = cuisineEmptyMessage(vi, trimmedQuery);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {notice === null ? null : (
        <GlobalNotification
          variant={notice.variant}
          title={notice.title}
          description={notice.description}
          closeLabel={vi ? "Đóng thông báo" : "Dismiss notification"}
          autoDismissMs={notice.variant === "error" ? undefined : 6000}
          onClose={() => {
            setNotice(null);
          }}
        />
      )}
      <AdminToolbar>
        <TaxonomySearchField
          id="cuisine-search"
          label={vi ? "Tìm món ăn theo vùng" : "Search cuisines"}
          placeholder={vi ? "Ví dụ: việt" : "e.g. viet"}
          value={query}
          onChange={setQuery}
        />
      </AdminToolbar>
      {listQuery.isPending ? <AdminSkeleton label={vi ? "Đang tải…" : "Loading…"} /> : null}
      {listQuery.isError ? (
        <AdminErrorState
          message={vi ? "Không tải được danh sách." : "Could not load cuisines."}
          retryLabel={vi ? "Thử lại" : "Try again"}
          pending={listQuery.isFetching}
          onRetry={() => {
            void listQuery.refetch();
          }}
        />
      ) : null}
      {listQuery.isSuccess && cuisines.length === 0 ? (
        <AdminEmptyState message={emptyMessage} />
      ) : null}
      {listQuery.isSuccess && cuisines.length > 0 ? (
        <AdminTable>
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-muted">
              <th scope="col" className="px-3 py-2">
                {vi ? "Tên" : "Name"}
              </th>
              <th scope="col" className="px-3 py-2">
                Slug
              </th>
            </tr>
          </thead>
          <tbody>
            {cuisines.map((cuisine) => (
              <tr key={cuisine.id} className="border-b border-border-soft last:border-0">
                <td className="px-3 py-2 font-medium">{cuisine.name}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{cuisine.slug}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <CuisineSingleAdd
        client={client}
        lang={lang}
        onDone={(entry) => {
          setNotice({
            variant: "success",
            title: vi ? "Đã lưu." : "Saved.",
            description: vi ? `Đã thêm cuisine “${entry}”.` : `Added cuisine “${entry}”.`,
          });
          void refresh();
        }}
        onFailed={() => {
          setNotice({
            variant: "error",
            title: vi ? "Lưu thất bại." : "Save failed.",
            description: vi
              ? "Thay đổi chưa được lưu. Làm mới danh sách rồi thử lại."
              : "That change did not save. Refresh the list and try again.",
          });
        }}
      />
      <CuisineBulkAdd client={client} lang={lang} onChanged={refresh} />
    </div>
  );
}

function CuisineSingleAdd({
  client,
  lang,
  onDone,
  onFailed,
}: {
  readonly client: TaxonomyClient;
  readonly lang: Locale;
  readonly onDone: (name: string) => void;
  readonly onFailed: () => void;
}): ReactNode {
  const vi = lang === "vi";
  const [name, setName] = useState("");
  const [slugOverride, setSlugOverride] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const derived = deriveSlug(name.trim());
  const slug = slugOverride ?? derived;
  const slugTouched = slugOverride !== null;
  const slugValid = slug === "" || isValidSlug(slug);
  const canSubmit = name.trim() !== "" && slugValid && !pending;
  const slugError = cuisineSlugError(slugValid, vi);
  const showSlugHint = slugValid && !slugTouched;
  const slugHint = cuisineSlugHint(vi, derived);
  const submitLabel = pending ? cuisinePendingLabel(vi) : cuisineSubmitLabel(vi);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setPending(true);
    const payload = slug === "" ? { name: name.trim() } : { name: name.trim(), slug };

    client
      .createCuisine(payload)
      .then((result) => {
        setName("");
        setSlugOverride(null);
        onDone(result.cuisine.name);
      })
      .catch(() => {
        onFailed();
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <AdminSection title={vi ? "Thêm cuisine" : "Add a cuisine"}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <AdminField
          id="cuisine-name"
          label={vi ? "Tên hiển thị" : "Display name"}
          placeholder={vi ? "Ví dụ: Ẩm thực Huế" : "e.g. Hue cuisine"}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={120}
          autoComplete="off"
        />
        <AdminField
          id="cuisine-slug"
          label="Slug"
          placeholder={derived === "" ? "auto" : derived}
          value={slug}
          onChange={(event) => {
            setSlugOverride(event.target.value.trim() === "" ? null : event.target.value.trim());
          }}
          maxLength={80}
          autoComplete="off"
          error={slugError}
        />
        {showSlugHint ? <output className="text-sm text-muted">{slugHint}</output> : null}
        <div>
          <AdminPrimaryButton type="submit" disabled={!canSubmit} aria-busy={pending}>
            {submitLabel}
          </AdminPrimaryButton>
        </div>
      </form>
    </AdminSection>
  );
}

function CuisineBulkAdd({
  client,
  lang,
  onChanged,
}: {
  readonly client: TaxonomyClient;
  readonly lang: Locale;
  readonly onChanged: () => Promise<void>;
}): ReactNode {
  const vi = lang === "vi";
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [localErrors, setLocalErrors] = useState<ReadonlyArray<string>>([]);

  const [lastResult, setLastResult] = useState<{
    readonly entries: ReadonlyArray<BulkCuisineEntry>;
    readonly result: BulkCuisineResult;
  } | null>(null);

  const rows = useMemo(
    () =>
      lastResult === null ? [] : resolveCuisineRowStatuses(lastResult.entries, lastResult.result),
    [lastResult],
  );

  let bulkLabel: string;

  if (pending) {
    bulkLabel = vi ? "Đang thêm…" : "Adding…";
  } else {
    bulkLabel = vi ? "Thêm hàng loạt" : "Bulk add";
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    if (pending || draft.trim() === "") {
      return;
    }

    const parsed: Array<BulkCuisineEntry> = [];
    const failures: Array<string> = [];

    for (const line of draft.split("\n")) {
      const row = parseCuisineBulkLine(line);

      if (row.kind === "empty") {
        continue;
      }

      if (row.kind === "cuisine") {
        parsed.push(row.entry);
        continue;
      }

      if (row.kind === "cuisine-invalid") {
        failures.push(`${row.raw}: ${row.reason}`);
      }
    }

    setLocalErrors(failures);

    if (parsed.length === 0) {
      setLastResult(null);

      return;
    }

    setPending(true);
    client
      .bulkCreateCuisines({ entries: parsed })
      .then((result) => {
        setLastResult({ entries: parsed, result });
        setDraft("");
        void onChanged();
      })
      .catch(() => {
        setLastResult(null);
        setLocalErrors([
          vi
            ? "Thêm hàng loạt thất bại. Làm mới danh sách rồi thử lại."
            : "Bulk add failed. Refresh the list and try again.",
        ]);
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <AdminSection title={vi ? "Thêm hàng loạt" : "Bulk add"}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="cuisine-bulk" className="text-sm font-semibold">
            {vi ? "Danh sách cuisine" : "Cuisine list"}
          </label>
          <p className="text-sm text-muted">
            {vi
              ? "Mỗi dòng một mục: “Tên hiển thị” hoặc “slug | Tên hiển thị”."
              : "One entry per line: “Display Name” or “slug | Display Name”."}
          </p>
          <textarea
            id="cuisine-bulk"
            value={draft}
            rows={6}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder={vi ? "Ẩm thực Huế\nhue | Ẩm thực Huế" : "Hue cuisine\nhue | Hue cuisine"}
            className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 font-mono text-sm text-ink"
          />
        </div>
        {localErrors.length > 0 ? (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2">
            <ul className="list-disc pl-5 text-sm font-semibold text-red-800">
              {localErrors.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <AdminGhostButton type="button" onClick={() => setDraft("")} disabled={pending}>
            {vi ? "Xóa" : "Clear"}
          </AdminGhostButton>
          <AdminPrimaryButton type="submit" disabled={pending} aria-busy={pending}>
            {bulkLabel}
          </AdminPrimaryButton>
        </div>
      </form>
      {lastResult === null ? null : (
        <AdminCard>
          <BulkResultList
            createdCount={lastResult.result.created.length}
            emptyMessage={vi ? "Không có dòng nào." : "No rows submitted."}
            rows={rows}
          />
        </AdminCard>
      )}
    </AdminSection>
  );
}

const cuisineEmptyMessage = (vi: boolean, query: string): string => {
  if (query === "") {
    return vi ? "Chưa có cuisine nào." : "No cuisines yet.";
  }

  if (vi) {
    return `Không tìm thấy “${query}”.`;
  }

  return `No cuisines match “${query}”.`;
};

const cuisineSlugError = (slugValid: boolean, vi: boolean): string | null => {
  if (slugValid) {
    return null;
  }

  if (vi) {
    return "Slug chỉ gồm chữ thường, số và gạch nối.";
  }

  return "Slug must be lowercase letters, digits and single hyphens.";
};

const cuisineSlugHint = (vi: boolean, derived: string): string => {
  if (derived === "") {
    return vi ? "Nhập tên để tự tạo slug." : "Type a name to auto-derive the slug.";
  }

  if (vi) {
    return `Slug tự tạo: ${derived}`;
  }

  return `Auto-derived slug: ${derived}`;
};

const cuisinePendingLabel = (vi: boolean): string => (vi ? "Đang lưu…" : "Saving…");

const cuisineSubmitLabel = (vi: boolean): string => (vi ? "Thêm cuisine" : "Add cuisine");
