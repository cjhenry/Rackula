export type PreviewFace = "front" | "rear";
export interface PreviewInput {
  layoutId: string;
  revision: number;
  snapshotHash: string;
  sourceInstance: string;
  content: string;
  rackIds: string[];
  assets: { key: string; face: PreviewFace; mimeType: string; data: string }[];
}
export interface PreviewMetadata {
  schemaVersion: 1;
  sourceInstance: string;
  layoutId: string;
  rackId: string;
  face: PreviewFace;
  revision: number;
  snapshotHash: string;
  contentHash: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  generatedAt: string;
}
export interface RenderResult {
  png: string;
  width: number;
  height: number;
  warnings: string[];
}
