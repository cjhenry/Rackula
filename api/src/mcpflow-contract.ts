export interface SyncDevice {
  id: string;
  typeId: string;
  name: string;
  face: "front" | "rear" | "both";
  positionU: number | null;
  heightU: number;
  containerId: string | null;
  slotId: string | null;
}
export interface SyncSnapshot {
  name: string;
  deviceTypes: {
    id: string;
    manufacturer: string;
    model: string;
    slots: { id: string; name: string }[];
  }[];
  racks: {
    id: string;
    name: string;
    heightU: number;
    startingUnit: number;
    descending: boolean;
    devices: SyncDevice[];
  }[];
  equipment: Record<string, Record<string, string | number | null>>;
  source?: Record<string, unknown>;
}
export interface SyncPayload {
  action: "sync_layout";
  schemaVersion: 2;
  sourceInstance: string;
  layoutId: string;
  revision: number;
  operation: "upsert" | "delete";
  sourceUpdatedAt: string;
  clientId?: number;
  locationId?: number | null;
  siteName?: string;
  snapshot?: SyncSnapshot;
}
