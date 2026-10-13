import type { AssetMap } from "./assetMap";
import { EDS_COLUMN, rowsToCsv } from "./csv";
import { parseCsv } from "./csvParse";

export interface EdsCsvResult {
  csv: string;
  rows: number;
  mapped: number;
  byMethod: Record<string, number>;
  /** Unique image URLs that had no match. */
  unmatched: string[];
}

/**
 * Adds (or refreshes) the "EDS image path" column in a CSV that has an "Image URL" column.
 * All other columns are kept as they are. Returns null when the CSV has no "Image URL" column.
 */
export function addEdsColumn(csvText: string, map: AssetMap): EdsCsvResult | null {
  const [header, ...rows] = parseCsv(csvText);
  const imageCol = header?.findIndex((h) => h.trim().toLowerCase() === "image url") ?? -1;
  if (!header || imageCol < 0) return null;

  let edsCol = header.findIndex((h) => h.trim().toLowerCase() === EDS_COLUMN.toLowerCase());
  if (edsCol < 0) {
    header.push(EDS_COLUMN);
    edsCol = header.length - 1;
  }

  const dataRows = rows.filter((r) => r.some((v) => v !== ""));
  const byMethod: Record<string, number> = {};
  const unmatched = new Set<string>();
  let mapped = 0;
  for (const row of dataRows) {
    const imageUrl = row[imageCol] ?? "";
    const match = map.lookup(imageUrl);
    row[edsCol] = match?.openApiUrl ?? "";
    if (match) {
      mapped++;
      const method = match.matchedBy.replace(/ \(.*\)$/, "");
      byMethod[method] = (byMethod[method] ?? 0) + 1;
    } else if (imageUrl) {
      unmatched.add(imageUrl);
    }
  }

  return { csv: rowsToCsv(header, dataRows), rows: dataRows.length, mapped, byMethod, unmatched: [...unmatched] };
}
