import { connection } from "next/server";
import { listAssetMapFiles } from "@/lib/assetMap";

/** Lists the asset map CSVs available in ./input (the first one is the default). */
export async function GET() {
  await connection();
  return Response.json({ files: await listAssetMapFiles() }, { headers: { "Cache-Control": "no-store" } });
}
