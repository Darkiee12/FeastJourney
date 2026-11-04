import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useDebouncedValue } from "@/components/admin/taxonomy/cuisine-panel";
import {
  parseIngredientBulkLine,
  resolveIngredientRowStatuses,
  type BulkIngredientEntry,
  type BulkIngredientResult,
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

interface Notice {
  readonly variant: GlobalNotificationVariant;
  readonly title: string;
  readonly description: string;
}

/**
 * Ingredients tab: searchable list, single-add (name plus optional BCP-47
 * language tag), and bulk-add (one `languageTag | Display Name` line each)
 * with per-row created/skipped/invalid outcomes.
 */
export function IngredientPanel({
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
    queryKey: ["admin", "taxonomy", "ingredients", trimmedQuery],
    queryFn: () =>
      client.listIngredients({
        query: trimmedQuery === "" ? undefined : trimmedQuery,
        limit: PAGE_SIZE,
        offset: 0,
      }),
    staleTime: 15_000,
    retry: 1,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "taxonomy", "ingredients"] });
  };

  const ingredients = useMemo(() => listQuery.data?.ingredients ?? [], [listQuery.data]);

  const emptyMessage = ingredientEmptyMessage(vi, trimmedQuery);

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
          id="ingredient-search"
          label={vi ? "Tìm nguyên liệu" : "Search ingredients"}
          placeholder={vi ? "Ví dụ: rau" : "e.g. basil"}
          value={query}
          onChange={setQuery}
        />
      </AdminToolbar>
      {listQuery.isPending ? <AdminSkeleton label={vi ? "Đang tải…" : "Loading…"} /> : null}
      {listQuery.isError ? (
        <AdminErrorState
          message={vi ? "Không tải được danh sách." : "Could not load ingredients."}
          retryLabel={vi ? "Thử lại" : "Try again"}
          pending={listQuery.isFetching}
          onRetry={() => {
            void listQuery.refetch();
          }}
        />
      ) : null}
      {listQuery.isSuccess && ingredients.length === 0 ? (
        <AdminEmptyState message={emptyMessage} />
      ) : null}
      {listQuery.isSuccess && ingredients.length > 0 ? (
        <AdminTable>
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-muted">
              <th scope="col" className="px-3 py-2">
                {vi ? "Tên" : "Name"}
              </th>
            </tr>
          </thead>
          <tbody>
            {ingredients.map((ingredient) => (
              <tr key={ingredient.id} className="border-b border-border-soft last:border-0">
                <td className="px-3 py-2 font-medium">{ingredient.name}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <IngredientSingleAdd
        client={client}
        lang={lang}
        onDone={(entry) => {
          setNotice({
            variant: "success",
            title: vi ? "Đã lưu." : "Saved.",
            description: vi ? `Đã thêm nguyên liệu “${entry}”.` : `Added ingredient “${entry}”.`,
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
      <IngredientBulkAdd client={client} lang={lang} onChanged={refresh} />
    </div>
  );
}

function IngredientSingleAdd({
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
  const [languageTag, setLanguageTag] = useState("");
  const [pending, setPending] = useState(false);

  const canSubmit = name.trim() !== "" && !pending;
  const submitLabel = pending ? ingredientPendingLabel(vi) : ingredientSubmitLabel(vi);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setPending(true);
    const tag = languageTag.trim();

    client
      .createIngredient(
        tag === "" ? { name: name.trim() } : { name: name.trim(), languageTag: tag },
      )
      .then((result) => {
        setName("");
        setLanguageTag("");
        onDone(result.ingredient.name);
      })
      .catch(() => {
        onFailed();
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <AdminSection title={vi ? "Thêm nguyên liệu" : "Add an ingredient"}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <AdminField
          id="ingredient-name"
          label={vi ? "Tên hiển thị" : "Display name"}
          placeholder={vi ? "Ví dụ: Rau muống" : "e.g. Water spinach"}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={120}
          autoComplete="off"
        />
        <AdminField
          id="ingredient-language"
          label={vi ? "Mã ngôn ngữ (không bắt buộc)" : "Language tag (optional)"}
          placeholder="vi"
          value={languageTag}
          onChange={(event) => {
            setLanguageTag(event.target.value);
          }}
          maxLength={20}
          autoComplete="off"
        />
        <div>
          <AdminPrimaryButton type="submit" disabled={!canSubmit} aria-busy={pending}>
            {submitLabel}
          </AdminPrimaryButton>
        </div>
      </form>
    </AdminSection>
  );
}

function IngredientBulkAdd({
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
    readonly entries: ReadonlyArray<BulkIngredientEntry>;
    readonly result: BulkIngredientResult;
  } | null>(null);

  const rows = useMemo(
    () =>
      lastResult === null
        ? []
        : resolveIngredientRowStatuses(lastResult.entries, lastResult.result),
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

    const parsed: Array<BulkIngredientEntry> = [];
    const failures: Array<string> = [];

    for (const line of draft.split("\n")) {
      const row = parseIngredientBulkLine(line);

      if (row.kind === "empty") {
        continue;
      }

      if (row.kind === "ingredient") {
        parsed.push(row.entry);
        continue;
      }

      if (row.kind === "ingredient-invalid") {
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
      .bulkCreateIngredients({ entries: parsed })
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
          <label htmlFor="ingredient-bulk" className="text-sm font-semibold">
            {vi ? "Danh sách nguyên liệu" : "Ingredient list"}
          </label>
          <p className="text-sm text-muted">
            {vi
              ? "Mỗi dòng một mục: “Tên hiển thị” hoặc “mã ngôn ngữ | Tên hiển thị”."
              : "One entry per line: “Display Name” or “languageTag | Display Name”."}
          </p>
          <textarea
            id="ingredient-bulk"
            value={draft}
            rows={6}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder={vi ? "Rau muống\nvi | Rau muống" : "Water spinach\nen | Water spinach"}
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
            createdCount={lastResult.result.created}
            emptyMessage={vi ? "Không có dòng nào." : "No rows submitted."}
            rows={rows}
          />
        </AdminCard>
      )}
    </AdminSection>
  );
}

const ingredientEmptyMessage = (vi: boolean, query: string): string => {
  if (query === "") {
    return vi ? "Chưa có nguyên liệu nào." : "No ingredients yet.";
  }

  if (vi) {
    return `Không tìm thấy “${query}”.`;
  }

  return `No ingredients match “${query}”.`;
};

const ingredientPendingLabel = (vi: boolean): string => (vi ? "Đang lưu…" : "Saving…");

const ingredientSubmitLabel = (vi: boolean): string => (vi ? "Thêm nguyên liệu" : "Add ingredient");
