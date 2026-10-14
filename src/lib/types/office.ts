export interface Client {
  id: string;
  name: string;
  mcpClientId?: number;
}
export interface Site {
  id: string;
  clientId: string;
  name: string;
  address?: string;
  mcpLocationId?: number;
}
export interface Equipment {
  serial: string;
  assetTag: string;
  hostname: string;
  managementIp: string;
  installed: string;
  warrantyExpires: string;
  notes: string;
  mcpAssetId?: number;
}
export interface Assignment {
  clientId: string;
  siteId: string;
  equipment: Record<string, Equipment>;
  lastPushedAt?: string;
  mcpDocumentId?: number;
}
export interface OfficeUser {
  id: string;
  username: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  clientIds: string[];
  disabled: boolean;
}
