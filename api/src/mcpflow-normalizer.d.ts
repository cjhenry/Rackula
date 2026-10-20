import type { SyncSnapshot } from "./mcpflow-contract";
export function normalizeLayout(
  content: string,
  layoutId: string,
): SyncSnapshot;

export function migrateLayout(
  content: string,
  layoutId: string,
): import("$lib/types").Layout;
