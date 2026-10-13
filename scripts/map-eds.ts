/**
 * Adds (or refreshes) the "EDS image path" column in CSVs that were already generated.
 *
 *   npm run map-eds -- <csv-file-or-folder> [--asset-map input/asset-map-dev.csv] [--out DIR]
 *
 * Folders are searched recursively. Files are updated in place unless --out is given.
 * The image URL is read from the "Image URL" column.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAssetMap } from "../src/lib/assetMap";
import { addEdsColumn } from "../src/lib/edsCsv";
import { parseArgs } from "./args";

async function listCsvFiles(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return target.toLowerCase().endsWith(".csv") ? [target] : [];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const full = path.join(target, e.name);
      if (e.isDirectory()) return listCsvFiles(full);
      return Promise.resolve(e.name.toLowerCase().endsWith(".csv") ? [full] : []);
    }),
  );
  return nested.flat();
}

async function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const target = positional[0];
  if (!target) {
    console.error("Usage: npm run map-eds -- <csv-file-or-folder> [--asset-map FILE] [--out DIR]");
    process.exit(1);
  }
  const loaded = await loadAssetMap(args["asset-map"]);
  if (!loaded) {
    console.error("No asset map found. Put it in ./input (e.g. input/asset-map-dev.csv) or pass --asset-map FILE.");
    process.exit(1);
  }
  console.log(`EDS mapping: ${loaded.file} (${loaded.map.size.toLocaleString()} assets)`);

  const root = path.resolve(target);
  const rootDir = (await stat(root)).isFile() ? path.dirname(root) : root;
  const inputDir = path.resolve("input");
  const files = (await listCsvFiles(root)).filter((f) => !path.resolve(f).startsWith(inputDir + path.sep));

  let totalRows = 0;
  let mappedRows = 0;
  let updatedFiles = 0;
  const byMethod: Record<string, number> = {};

  for (const file of files) {
    const result = addEdsColumn(await readFile(file, "utf8"), loaded.map);
    if (!result) {
      console.log(`  skipped (no "Image URL" column): ${path.relative(process.cwd(), file)}`);
      continue;
    }
    totalRows += result.rows;
    mappedRows += result.mapped;
    for (const [method, n] of Object.entries(result.byMethod)) byMethod[method] = (byMethod[method] ?? 0) + n;
    const dest = args.out ? path.join(path.resolve(args.out), path.relative(rootDir, file)) : file;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, result.csv, "utf8");
    updatedFiles++;
  }

  console.log(`Updated ${updatedFiles} CSV file(s): EDS image path found for ${mappedRows}/${totalRows} rows`, byMethod);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
