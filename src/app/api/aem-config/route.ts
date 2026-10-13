import { createConfigNodes, findConfigPages, loadPreviewMappings, persistConfig, SAVED_CONFIG_NAME, validateConfigInput, type ConfigEntry } from "@/lib/aemConfig";
import { parseSavedConfig } from "@/lib/aemConfigMapping";

export const maxDuration = 300;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isObject(body)) throw new Error("Expected a JSON object.");
    if (body.action === "save-config") {
      await persistConfig(parseSavedConfig(body.config));
      return Response.json({ saved: SAVED_CONFIG_NAME }, { headers: { "Cache-Control": "no-store" } });
    }
    if (typeof body.author !== "string" || typeof body.username !== "string" || typeof body.password !== "string" || typeof body.root !== "string") {
      throw new Error("Enter Author URL, username, password and root.");
    }
    const input = validateConfigInput({
      author: body.author,
      username: body.username,
      password: body.password,
      root: body.root,
    });
    if (!("action" in body) || !["preview", "apply"].includes(String(body.action))) throw new Error("Invalid action.");
    const environment = body.environment === undefined ? "prod" : body.environment;
    if (environment !== "dev" && environment !== "test" && environment !== "qa" && environment !== "prod") {
      throw new Error("Choose an environment: dev, test, qa or prod.");
    }
    const pages = await findConfigPages(input);
    if (body.action === "preview") return Response.json({ pages, ...await loadPreviewMappings(pages, environment) }, { headers: { "Cache-Control": "no-store" } });
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every((entry): entry is ConfigEntry =>
      isObject(entry) && typeof entry.page === "string" && typeof entry.value === "string" && !!entry.value.trim(),
    )) {
      throw new Error("Enter a Value for every ab-config page before applying.");
    }
    if (new Set(entries.map((entry) => entry.page)).size !== entries.length) throw new Error("Each ab-config page must occur only once.");
    if (entries.some((entry) => !pages.includes(entry.page))) {
      throw new Error("Preview again: the selected pages are no longer in the query results.");
    }
    const results = await createConfigNodes(input, entries);
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "AEM request failed." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
