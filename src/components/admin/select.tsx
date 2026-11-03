/**
 * Feast Lab select entry point. The implementation lives in the shared
 * primitive (`@/components/ui/select`); this module only preserves the
 * admin import path so existing screens keep compiling with zero behavior
 * change. New code should import the shared primitive directly.
 */
export {
  SharedSelect as AdminSelect,
  SharedSelectField as AdminSelectField,
} from "@/components/ui/select";

export type {
  SharedSelectOption as AdminSelectOption,
  SharedSelectSection as AdminSelectSection,
  SharedSelectSize as AdminSelectSize,
} from "@/components/ui/select";
