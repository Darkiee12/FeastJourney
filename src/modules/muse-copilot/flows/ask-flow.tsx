import type { ReactNode } from "react";

import type { WorkspacePanelApi } from "@/modules/muse-copilot/flows/task-panel";

/**
 * Ask panel. Asking about food is pure conversation — the workspace thread,
 * composer, and follow-ups are its entire UI, so this panel renders
 * nothing. The module stays as the task's home for future ask-specific
 * affordances.
 */
export function AskPanel(_api: WorkspacePanelApi): ReactNode {
  return null;
}

export default AskPanel;
