/** Browser backup policy around the shared, server-safe layout migrations. */
import type { Layout } from "$lib/types";
import { adaptLegacyLayout as adapt } from "./adapt-legacy-layout-core";
import { ensurePreCarrierBackup } from "./pre-carrier-backup";
import { getStorageMode } from "./availability.svelte";
import { markPreCarrierMigrationPending } from "./pre-carrier-migration-pending";

export {
  CARRIER_2COL_SLUG,
  CARRIER_2X2_SLUG,
  CARRIER_2U_2COL_SLUG,
} from "./adapt-legacy-layout-core";

export function adaptLegacyLayout(layout: Layout): Layout {
  return adapt(layout, (original) => {
    if (getStorageMode() === "server") {
      if (original.metadata?.id)
        markPreCarrierMigrationPending(original.metadata.id);
    } else {
      ensurePreCarrierBackup();
    }
  });
}
