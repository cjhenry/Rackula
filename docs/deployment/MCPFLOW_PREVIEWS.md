# MCPFlow rack previews: additive contract and receiver implementation prompt

Status: finalized sender contract for implementation. The deployed MCPFlow receiver does not yet implement it. Do not enable Rackula preview uploads until the receiver passes the tests below. Existing schema-version-2 snapshot, catalog and manual report contracts remain unchanged. No preview creates a Document.

## Upload contract, version 1

POST the existing `MCPFLOW_INTEGRATION_URL` with its existing `Authorization: Bearer TOKEN`. Use multipart/form-data with exactly these fields:

- `action`: `upload_preview`.
- `metadata`: UTF-8 JSON string, maximum 8,192 bytes.
- `image`: one binary PNG file, content type `image/png`, filename `preview.png`.

The full encoded multipart body is at most 4,259,840 bytes (4 MiB PNG plus 64 KiB framing). The proxy ceiling for the shared integration route must permit this body size. The receiver selects the preview limit only for multipart uploads and retains the existing 1,048,576-byte JSON snapshot cap. Enforce the multipart ceiling before PHP parses the upload. Set `upload_max_filesize >= 4M` and `post_max_size >= 5M`, and reject extra files/fields. Do not accept SVG, remote image URLs or base64 JSON uploads.

```json
{
  "schemaVersion": 1,
  "sourceInstance": "ict365-rackula",
  "layoutId": "e1996c4f-5959-42b0-9e80-931c5a6ea24a",
  "rackId": "fhmR9pjhYk_RW_vXaBJgd",
  "face": "front",
  "revision": 1,
  "snapshotHash": "a4f78da8b4816b457259f87f7c5f5c35194a74183a0dd81c3e4bd69daf6e9dd6",
  "contentHash": "e2d9a36695f1821eff502d0a3a1ea59204dd5f8e6c073e54a6ba22bcba46636b",
  "mimeType": "image/png",
  "width": 520,
  "height": 2176,
  "byteLength": 362332,
  "generatedAt": "2026-10-20T19:56:33Z"
}
```

`revision` is the exact acknowledged safe-integer snapshot revision. `snapshotHash` is the exact hash returned by `sync_layout`, not a sender hash. `contentHash` is lowercase SHA-256 of the PNG bytes. Source, UUID and rack identifiers follow the existing snapshot rules, preserving case for rack IDs. Face is exactly `front` or `rear`. No client/location fields: derive ownership from the locked accepted snapshot.

Limits: PNG length 1..4,194,304 bytes, width and height integers 1..8,192, at most 16,000,000 pixels. Verify PNG signature, actual decoded MIME/dimensions and complete decode, declared byte length and SHA-256. Reject animated/multiple-frame images. `generatedAt` is exact UTC seconds and represents rendering, not retries. It is diagnostic and does not participate in identity or idempotence. Store no uploaded filename/path supplied by the caller.

Identity: `(sourceInstance, layoutId, rackId, face, revision)`. Accept only if the layout is active at exactly this revision/hash and the rack exists in its normalized snapshot. Serialize preview and snapshot mutations with the same global layout advisory lock. A newer receiver snapshot returns `superseded` without writing image data. A missing, tombstoned or not-yet-current snapshot/rack cannot accept a preview.

HTTP 200 acknowledgement (illustrative; these local example bytes have not been uploaded to MCPFlow):

```json
{
  "ok": true,
  "layoutId": "e1996c4f-5959-42b0-9e80-931c5a6ea24a",
  "rackId": "fhmR9pjhYk_RW_vXaBJgd",
  "face": "front",
  "acceptedRevision": 1,
  "result": "applied",
  "contentHash": "e2d9a36695f1821eff502d0a3a1ea59204dd5f8e6c073e54a6ba22bcba46636b"
}
```

`unchanged` has the same shape and means identical PNG hash/dimensions already committed. Equal identity with different PNG content is HTTP 409 `{"error":"Preview identity already has different content","code":"preview_conflict"}`. Do not overwrite it. Restoring a render queue must retain its PNG bytes; changing renderer/assets requires a newer snapshot revision, never overwriting an accepted preview.

`superseded` uses the same shape but returns the receiver's newer `acceptedRevision` and `contentHash:null`. The sender retires that obsolete job; it does not acknowledge newer pending images. If the receiver revision is lower, return HTTP 409 `{"error":"Snapshot revision not accepted yet","code":"snapshot_not_ready"}` for a delayed retry. Missing layout/rack, deleted layouts and current revision/hash mismatch return 422 with a clear error and code (`layout_unavailable`, `rack_unavailable`, `snapshot_hash_mismatch`). Authentication/source rejection remains 401/403. Invalid multipart is 400, excessive body/image 413, invalid PNG/metadata 422. Transient locking/setup errors are 503; unexpected failures 500. Use 429 and Retry-After for throttling. No success before durable file and database commit.

Example (token is an existing server-side environment variable; never a literal secret):

```sh
curl --fail-with-body --max-time 20 \
  -H "Authorization: Bearer $MCPFLOW_INTEGRATION_TOKEN" \
  -F action=upload_preview \
  -F 'metadata=<preview-metadata.json;type=application/json' \
  -F 'image=@rack-front.png;type=image/png;filename=preview.png' \
  "$MCPFLOW_INTEGRATION_URL"
```

For rear upload, use `face:"rear"`, its own PNG hash/dimensions/length, and the same accepted revision/hash. Send each rack/face separately. Retrying uses the exact same metadata and bytes. Time out after 20 seconds, reject redirects, bound responses to 64 KiB, redact secrets, retry network/429/5xx and `snapshot_not_ready` with bounded backoff and Retry-After (capped at one hour); permanent errors require operator action.

## Precise MCPFlow implementation prompt

Implement the receiver and private viewer for the upload contract above. Read repository instructions and current `docs/features/rackula/SYNC_CONTRACT.md`; this document is an additive handoff, not a replacement for version 2. Preserve catalog, manual reports, snapshot behavior, the enabled rack viewer, existing assets and legacy records. Do not restart MCPFlow unless its deployment instructions make it necessary.

1. Add a migration using the next free number after inspecting existing migrations; do not reuse unrelated migration 185. Add a private preview metadata table keyed by source/layout/rack/face/revision, with snapshot/content hashes, MIME, dimensions, byte length, generated/accepted timestamps and an opaque storage key. Store PNGs outside the web root on a persistent volume, not in public uploads or Documents.
2. Detect and authenticate the preview multipart action before the existing JSON parser and 1 MiB JSON limit. Enforce separate preview limits. Bind source to the existing token. Validate every field strictly, verify actual image bytes, active client/location ownership, exact accepted revision/hash and rack membership under the same global layout lock used by sync_layout.
3. Stage and fsync a validated image under an application-generated name, atomically rename it, and commit its metadata before success. Fail safely on disk/SQL errors. Clean abandoned staging/orphan files with a bounded cleanup job; never remove a currently referenced file. Lost acknowledgements must yield unchanged; equal identity conflicts must yield 409.
4. Make every image read join the currently authorized client's active snapshot and require equal revision AND snapshot hash plus rack membership. Any newer snapshot, rack removal, deletion, reassignment or unassignment must make the prior images inaccessible immediately, even if physical cleanup fails. Archive/purge old metadata/files after commit. Retain snapshot tombstones. A malicious/late upload must never revive access for a former client.
5. Add a session-authenticated image GET endpoint under agent/, requiring existing module_support and client access. Resolve by opaque preview ID, never caller file path. Recheck current layout/client/revision at serving time. Return image/png, nosniff, Content-Disposition inline, Cache-Control private,no-store and no public cache/CDN URL. Reject unauthorized, stale/deleted and cross-client requests without disclosing image bytes. Token stays server-side; no shared Rackula browser session or network request at MCPFlow page load.
6. Display the selected face's local preview alongside synchronized equipment details. A click opens a larger image in an accessible modal (keyboard close, focus restoration, meaningful alt text). Show revision/generated time; distinguish pending/missing, failed/unavailable and stale snapshot states. Fall back to the existing native elevation and details whenever no matching preview is available. Missing previews alone do not prove a sender failure; link operators to Rackula for rendering/delivery errors. Never label an old preview as current, and never use an authenticated cross-origin iframe or incoming SVG/HTML.
7. Add HTTP/database/file tests for auth, source binding, limits, real PNG decode/hash/dimensions, applied/unchanged/conflict, out-of-order uploads, snapshot-first ordering, atomic failures, read-time client isolation, rack removal, deletion, reassignment, unassignment, cache headers and frontend enlargement/fallback. Verify 2-rack/25-device SIHS remains unchanged and no Documents are created. Then coordinate preview enablement/backfill with Rackula. Do not claim completion until all four SIHS rack/face previews are accepted and rendered in an authenticated browser.

## Rackula deployment requirements

The publisher is disabled by default with `MCPFLOW_PREVIEWS_ENABLED=false`. It reuses integration URL/token/source, requires the working snapshot publisher, persistent complete DATA_DIR, the generated browser-renderer bundle, playwright-core and a matching system/headless Chromium executable. Use `MCPFLOW_CHROMIUM_EXECUTABLE` for a system Chromium; otherwise install the matching Playwright Chromium into the runtime image and set its browser path. Rendering runs in a separate bounded child process, one job at a time, without an operator browser. Include fonts and enough memory/PID/tmpfs capacity for Chromium. Use the preview-capable API Dockerfile and preserve non-root operation.

Back up `office/mcpflow-previews/` with publisher state and source data. Review render/delivery errors and missing-image warnings. Never enable uploads against the currently deployed MCPFlow receiver: it does not implement this action yet. Receiver deployment, private file storage, enlargement UI and coordinated live preview acceptance remain MCPFlow work.

## Operator endpoints and image revision rules

The session-authenticated Rackula API exposes these endpoints under `/office` and `/api/office`:

- `GET /preview-status`: authorized queue revision, current/outdated flag, per-rack face status, warnings and errors. Never returns frozen source, PNG bytes, token or disk paths.
- `POST /preview-backfill` with `{}`: administrator-only initial backfill. Returns `queued`, `waitingForSnapshot`, `skipped` and `errors`; queues only acknowledged linked layouts. Rendering and uploads run asynchronously when enabled.
- `POST /layouts/:id/preview-retry` with `{}`: editor/admin with client access retries failed jobs using existing PNGs when present.
- `POST /preview-backfill` with `{"advanceRevision":true}`: administrator-only intentional regeneration after a renderer/asset-library update or damaged/lost PNG. Advances linked snapshots first; previews wait for their new acknowledgements. Never replace an accepted image under the old revision.

Saved-source content changes, including visual-only edits, advance the snapshot revision even if the normalized equipment hash stays the same. The first reconciliation after this sender upgrade may advance existing layouts once to establish the visual capture hash. Uploaded image mutations are journaled under the snapshot publisher's layout lock and advance its revision even when normalized equipment data is unchanged. Existing PNGs and capture inputs are retained across delivery retries. Nonreferenced orphan asset files are not rendered. Worker rendering is serialized and isolated from snapshot delivery; each rack/face has a 60-second render timeout and each upload a 20-second timeout. Three failed render attempts stop with an operator error; network/server delivery retries continue with bounded backoff.

Input bounds: 1,000 source image faces, 5 MiB per source image, 16 MiB combined input rasters, 32 MiB serialized render input, 16 million decoded pixels per source image and a 64-million-pixel aggregate decoding budget per render (additional images fall back to labels), 1..8,192 pixels per dimension, 128 MiB cached PNGs per layout. All data/queue paths are application-generated and private. Invalid/missing raster inputs fall back to labels/bundled images and emit warnings. Exceeding aggregate bounds fails rendering visibly without affecting snapshot delivery.

Build the preview-capable image with `docker build -f api/Dockerfile.previews .`. Before rollout, scan/sign the new image and back up all data/configuration. Allow at least 1 GiB API container memory, a PID budget suitable for Chromium (256 suggested), and `/tmp` tmpfs of at least 256 MiB; the currently deployed 5 MiB tmpfs is insufficient. Keep non-root operation, no added privileges, private persistent data, and the existing network/auth restrictions. Chromium runs a fresh offline context, denies all resource requests, and receives no integration credentials. No application or external URLs from saved layouts are fetched. Generated bundles include trusted application image assets as data URLs.

For local validation, run `bun run test:previews` in api/ after installing dependencies and matching Chromium. Existing snapshot tests remain `bun run test`; the render suite is separately enabled with `RACKULA_PREVIEW_RENDER_TESTS=true` so non-browser API jobs do not silently require a system browser.

## Local implementation verification

The local SIHS backup contains the acknowledged 2-rack/25-device layout and eight uploaded image files. Four front/rear PNGs were generated using the shared export renderer. Distribution rack previews are 520 x 2,176 pixels; Core rack previews are 520 x 2,044 pixels. Sizes are below 385 KiB each. One referenced Distribution/front image is absent from the backup; its labeled fallback is intentional and reported as a warning.

The local HTTP test uses a contract reference receiver, not MCPFlow. It validates actual SIHS multipart uploads, PNG decoding/dimensions/content hashes, exact accepted snapshot identity and a lost acknowledgement followed by process restart/unchanged retry. The real MCPFlow receiver still needs the additive upload implementation above. No production preview deployment or end-to-end image acceptance is claimed.

Run the private SIHS HTTP fixture test with `RACKULA_SIHS_PREVIEW_INPUT=/protected/path/input.json bun test src/mcpflow-preview-http.test.ts` in api/. The input contains the coherent saved YAML, source/layout/revision/hash/rack identities and base64 raster assets matching the `PreviewInput` type. Keep client layouts and generated PNG examples outside Git; never add configuration or credentials to the fixture.

Final validation: 466 API tests passed across 31 files, including the real Chromium render tests, the actual SIHS multipart HTTP test and the existing PHP snapshot-contract checks. The combined workstation run used `bun test --timeout 30000` for filesystem/process tests; each renderer child retains its independent 60-second production timeout. Earlier default-timeout runs hit resource-related test timeouts; the final combined run passed with zero failures. Twenty existing export face/image/container tests and four Chromium operator/header tests passed. Svelte checks reported zero errors/warnings; API TypeScript, changed-file ESLint, formatting and Worker dry-run build passed.

The preview Dockerfile's Bun Debian base manifest was verified. The complete container image was not built in this workstation because Docker is unavailable here. Build, scan/sign, preview-capable container rollout, real MCPFlow upload acceptance and authenticated front/rear enlargement remain deployment/receiver work. The existing production publisher, manual reports, viewer flag and application containers were unchanged by this implementation.
