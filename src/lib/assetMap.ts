import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseCsvObjects } from "./csvParse";
import type { ImageRecord, StreamEvent } from "./types";

/**
 * Maps page image URLs to EDS asset URLs (openApiUrl) using an AEM asset-map CSV with columns
 * path, uuid, scene7Name, scene7File, damStatus, openApiUrl, isCF.
 */

interface AssetRow {
  path: string;
  uuid: string;
  scene7File: string;
  damStatus: string;
  openApiUrl: string;
}

export interface EdsMatch {
  openApiUrl: string;
  /** "scene7" | "dam-path" | "uuid", with " (ambiguous: N)" when several assets matched. */
  matchedBy: string;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "/content/dam/corporate/abbvie-com2/x.svg" and "/content/dam/abbvie-com2/x.svg" both -> "abbvie-com2/x.svg". */
export function damKey(p: string): string | null {
  const decoded = safeDecode(p);
  const m = decoded.match(/\/content\/dam\/(.+)$/);
  if (!m) return null;
  let key = m[1]
    // Drop AEM rendition / dynamic-media suffixes.
    .split("/jcr:content")[0]
    .replace(/\.(coreimg|transform|thumb|img)\..*$/i, "")
    .replace(/\.(coreimg|transform)\/.*$/i, "");
  key = key.replace(/^corporate\//, "");
  return key || null;
}

/** "https://abbvie.scene7.com/is/image/abbviecorp/name:Square?x=y" -> "abbviecorp/name". */
export function scene7Key(url: URL): string | null {
  if (!/(^|\.)scene7\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/is\/(?:image|content)\/(.+)$/i);
  if (!m) return null;
  // ":Square" etc. selects a smart-crop rendition, not a different asset.
  return safeDecode(m[1]).replace(/\/+$/, "").replace(/:[^/:]+$/, "");
}

function uuidKey(url: string): string | null {
  const m = url.match(/urn:aaid:aem:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

function push<K>(map: Map<K, AssetRow[]>, key: K, row: AssetRow) {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

export class AssetMap {
  private byScene7 = new Map<string, AssetRow[]>();
  private byScene7Lower = new Map<string, AssetRow[]>();
  private byDam = new Map<string, AssetRow[]>();
  private byDamLower = new Map<string, AssetRow[]>();
  private byUuid = new Map<string, AssetRow>();
  readonly size: number;

  constructor(rows: Record<string, string>[]) {
    let count = 0;
    for (const r of rows) {
      // Content fragments aren't images.
      if (r.isCF === "true" || !r.openApiUrl) continue;
      const row: AssetRow = {
        path: r.path ?? "",
        uuid: (r.uuid ?? "").toLowerCase(),
        scene7File: (r.scene7File ?? "").trim(),
        damStatus: r.damStatus ?? "",
        openApiUrl: r.openApiUrl,
      };
      count++;
      if (row.scene7File) {
        push(this.byScene7, row.scene7File, row);
        push(this.byScene7Lower, row.scene7File.toLowerCase(), row);
      }
      const key = damKey(row.path);
      if (key) {
        push(this.byDam, key, row);
        push(this.byDamLower, key.toLowerCase(), row);
      }
      if (row.uuid) this.byUuid.set(row.uuid, row);
    }
    this.size = count;
  }

  static fromCsv(text: string): AssetMap {
    return new AssetMap(parseCsvObjects(text));
  }

  /** Exact (case-sensitive) candidates first; case-insensitive only if that yields a single asset. */
  private candidates(exact: Map<string, AssetRow[]>, lower: Map<string, AssetRow[]>, key: string): AssetRow[] {
    const hit = exact.get(key);
    if (hit?.length) return hit;
    const loose = lower.get(key.toLowerCase());
    return loose?.length === 1 ? loose : [];
  }

  lookup(imageUrl: string, pageDamPath?: string): EdsMatch | null {
    const match = this.findRow(imageUrl, pageDamPath);
    if (!match) return null;
    const { row, how } = match;
    return { openApiUrl: row.openApiUrl, matchedBy: row.damStatus === "approved" ? how : `${how} (not approved)` };
  }

  private findRow(imageUrl: string, pageDamPath?: string): { row: AssetRow; how: string } | null {
    let url: URL | null = null;
    try {
      url = new URL(imageUrl);
    } catch {
      // not an absolute URL; only DAM-path matching can apply
    }
    const pageDamKey = pageDamPath ? damKey(pageDamPath) : null;
    const preferApproved = (rows: AssetRow[]) => rows.find((r) => r.damStatus === "approved") ?? rows[0];

    // 1. Scene7 file name, e.g. abbviecorp/pipette-closeup-1
    const s7 = url ? scene7Key(url) : null;
    if (s7) {
      const found = this.candidates(this.byScene7, this.byScene7Lower, s7);
      if (found.length === 1) return { row: found[0], how: "scene7" };
      if (found.length > 1) {
        // Several DAM copies share this Scene7 name: use the page's own DAM path to pick the right one.
        const exact = pageDamKey ? found.find((r) => damKey(r.path) === pageDamKey) : undefined;
        if (exact) return { row: exact, how: "scene7" };
        return { row: preferApproved(found), how: `scene7 (ambiguous: ${found.length})` };
      }
    }

    // 2. DAM path from the image URL, then from the page's data-asset attribute.
    for (const key of [url ? damKey(url.pathname) : damKey(imageUrl), pageDamKey]) {
      if (!key) continue;
      const found = this.candidates(this.byDam, this.byDamLower, key);
      if (found.length === 1) return { row: found[0], how: "dam-path" };
      if (found.length > 1) return { row: preferApproved(found), how: `dam-path (ambiguous: ${found.length})` };
    }

    // 3. AEM delivery URLs carry the asset UUID.
    const uuid = uuidKey(imageUrl);
    const byUuid = uuid ? this.byUuid.get(uuid) : undefined;
    if (byUuid) return { row: byUuid, how: "uuid" };

    return null;
  }

  enrich(records: ImageRecord[]): ImageRecord[] {
    for (const r of records) {
      const match = this.lookup(r.imageUrl, r.damPath);
      r.edsImagePath = match?.openApiUrl ?? "";
      r.edsMatch = match?.matchedBy ?? "";
    }
    return records;
  }

  /**
   * Stable identity for an asset reference, so the same asset matches regardless of delivery host,
   * rendition or format. Accepts delivery URLs (urn:aaid:aem:<uuid>), DAM paths and Scene7 URLs.
   */
  assetKey(ref: string): string | null {
    if (!ref) return null;
    const uuid = uuidKey(ref);
    if (uuid) return `uuid:${uuid}`;
    const key = damKey(ref);
    if (key) {
      const found = this.candidates(this.byDam, this.byDamLower, key);
      if (found.length === 1 && found[0].uuid) return `uuid:${found[0].uuid}`;
      return `dam:${key.toLowerCase()}`;
    }
    const match = this.findRow(ref);
    return match?.row.uuid ? `uuid:${match.row.uuid}` : null;
  }
}

export const INPUT_DIR = path.resolve(process.cwd(), "input");

export interface AssetMapFileInfo {
  name: string;
  sizeBytes: number;
  modified: string;
}

/** CSV files in ./input, newest asset-map*.csv first (the default), then other CSVs newest first. */
export async function listAssetMapFiles(): Promise<AssetMapFileInfo[]> {
  let names: string[];
  try {
    names = (await readdir(INPUT_DIR)).filter((n) => n.toLowerCase().endsWith(".csv"));
  } catch {
    return [];
  }
  const infos = await Promise.all(
    names.map(async (name) => {
      const s = await stat(path.join(INPUT_DIR, name));
      return { name, sizeBytes: s.size, modified: s.mtime.toISOString(), mtimeMs: s.mtimeMs };
    }),
  );
  infos.sort((a, b) => Number(/asset-?map/i.test(b.name)) - Number(/asset-?map/i.test(a.name)) || b.mtimeMs - a.mtimeMs);
  return infos.map(({ name, sizeBytes, modified }) => ({ name, sizeBytes, modified }));
}

/** Resolves a file name chosen in the UI to a path inside ./input (rejects anything else). */
export async function inputFilePath(name: string): Promise<string | null> {
  const files = await listAssetMapFiles();
  return files.some((f) => f.name === name) ? path.join(INPUT_DIR, name) : null;
}

/** Picks the asset map file: explicit path, ASSET_MAP_PATH env var, or the newest asset-map*.csv (else any .csv) in ./input. */
export async function resolveAssetMapFile(explicit?: string): Promise<string | null> {
  const chosen = explicit || process.env.ASSET_MAP_PATH;
  if (chosen) return path.resolve(chosen);
  const [first] = await listAssetMapFiles();
  return first ? path.join(INPUT_DIR, first.name) : null;
}

/** Loads the asset map for a streaming request and reports which file (if any) is in use. */
export async function loadAssetMapForStream(send: (event: StreamEvent) => void): Promise<AssetMap | undefined> {
  try {
    const loaded = await loadAssetMap();
    send({ type: "asset-map", file: loaded ? path.basename(loaded.file) : null, assets: loaded?.map.size ?? 0 });
    return loaded?.map;
  } catch (err) {
    send({ type: "asset-map", file: null, assets: 0, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

const cache = globalThis as unknown as { __assetMapCache?: Map<string, { mtimeMs: number; map: AssetMap }> };

/** Loads (and caches until the file changes) the asset map. Returns null when no file is available. */
export async function loadAssetMap(explicit?: string): Promise<{ file: string; map: AssetMap } | null> {
  const file = await resolveAssetMapFile(explicit);
  if (!file) return null;
  const { mtimeMs } = await stat(file);
  const store = (cache.__assetMapCache ??= new Map());
  const cached = store.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return { file, map: cached.map };
  const map = AssetMap.fromCsv(await readFile(file, "utf8"));
  // Keep only a few maps in memory.
  if (store.size >= 3) store.delete(store.keys().next().value!);
  store.set(file, { mtimeMs, map });
  return { file, map };
}
