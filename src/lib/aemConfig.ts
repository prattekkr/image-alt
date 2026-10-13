import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { domainForEnvironment, entriesFromConfig, normalizeContentRoot, parseSavedConfig, switchConfigEnvironment, type ConfigEnvironment, type SavedConfig } from "./aemConfigMapping";

export const CONFIG_KEY = "liveDomainToCacheIndex";
export const SAVED_CONFIG_NAME = "aem-ab-config-dev.json";
export { domainForEnvironment } from "./aemConfigMapping";
export type { ConfigEnvironment } from "./aemConfigMapping";

export interface AemConfigInput {
  author: string;
  username: string;
  password: string;
  root: string;
}

export interface ConfigEntry {
  page: string;
  value: string;
}

export interface ConfigPreviewEntry extends ConfigEntry {
  mappingStatus: "matched" | "unmatched" | "ambiguous" | "saved";
  sourceDomain?: string;
}

export function populateConfigEntries(pages: string[], data: unknown, environment: ConfigEnvironment = "prod"): ConfigPreviewEntry[] {
  if (!data || typeof data !== "object" || !("sites" in data) || !Array.isArray(data.sites)) {
    throw new Error("sites.json must contain a sites array.");
  }
  const domains = new Map<string, Set<string>>();
  const sites: unknown[] = data.sites;
  for (const [index, site] of sites.entries()) {
    if (!site || typeof site !== "object" || !("contentPath" in site) || typeof site.contentPath !== "string" || !("domain" in site) || typeof site.domain !== "string" || !site.domain.trim()) {
      throw new Error(`sites.json entry ${index + 1} needs nonempty domain and contentPath strings.`);
    }
    const contentPath = site.contentPath.trim().replace(/\/+$/, "");
    if (!contentPath.startsWith("/content/") || contentPath.slice(1).split("/").some((segment) => !segment || segment === "." || segment === "..") || /[?#\\%]/.test(contentPath)) {
      throw new Error(`sites.json entry ${index + 1} has an invalid contentPath.`);
    }
    const page = `${contentPath}/ab-config`;
    const values = domains.get(page) ?? new Set<string>();
    values.add(site.domain);
    domains.set(page, values);
  }
  return pages.map((page) => {
    const values = domains.get(page);
    if (!values) return { page, value: "", mappingStatus: "unmatched" };
    if (values.size !== 1) return { page, value: "", mappingStatus: "ambiguous" };
    const sourceDomain = [...values][0];
    return { page, sourceDomain, value: domainForEnvironment(sourceDomain, environment), mappingStatus: "matched" };
  });
}

export async function loadConfigEntries(pages: string[], environment: ConfigEnvironment = "prod"): Promise<ConfigPreviewEntry[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path.resolve(process.cwd(), "sites.json"), "utf8"));
  } catch (error) {
    throw new Error(`Unable to load sites.json: ${error instanceof Error ? error.message : "file read failed"}`);
  }
  return populateConfigEntries(pages, data, environment);
}

function fileNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export async function loadPreviewMappings(
  pages: string[],
  environment: ConfigEnvironment,
): Promise<{ entries: ConfigPreviewEntry[]; mappingSource: string }> {
  let text: string;
  try {
    text = await readFile(path.resolve(process.cwd(), SAVED_CONFIG_NAME), "utf8");
  } catch (error) {
    if (fileNotFound(error)) return { entries: await loadConfigEntries(pages, environment), mappingSource: "sites.json" };
    throw new Error(`Unable to read ${SAVED_CONFIG_NAME}: ${error instanceof Error ? error.message : "file read failed"}`);
  }
  const config = parseSavedConfig(JSON.parse(text));
  const discovered = new Set(pages);
  const savedEntries = entriesFromConfig(config).filter((entry) => discovered.has(entry.page));
  const converted = config.environment === environment ? savedEntries : switchConfigEnvironment(savedEntries, config.environment, environment);
  const byPage = new Map(converted.map((entry) => [entry.page, entry]));
  const missing = pages.filter((page) => !byPage.has(page));
  if (missing.length) {
    for (const entry of await loadConfigEntries(missing, environment)) byPage.set(entry.page, entry);
  }
  return { entries: pages.map((page) => byPage.get(page)!), mappingSource: SAVED_CONFIG_NAME };
}

export async function persistConfig(config: SavedConfig): Promise<void> {
  const validated = parseSavedConfig(config);
  const file = path.resolve(process.cwd(), SAVED_CONFIG_NAME);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2), { flag: "wx" });
    await rename(temporary, file);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!fileNotFound(error)) throw error;
    }
  }
}

export interface ConfigResult {
  page: string;
  status: "created" | "exists" | "failed";
  node: string;
  message: string;
}

export function validateConfigInput(input: AemConfigInput): AemConfigInput {
  const author = new URL(input.author);
  if (author.username || author.password || author.search || author.hash || author.pathname !== "/") {
    throw new Error("Author URL must contain only the scheme and host.");
  }
  if (author.protocol !== "https:" && !(author.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(author.hostname))) {
    throw new Error("Use HTTPS for Basic Auth (HTTP is allowed only for local AEM).");
  }
  const root = normalizeContentRoot(input.root);
  if (!input.username.trim() || input.username.includes(":") || !input.password) throw new Error("Enter a valid username and password.");
  return { ...input, author: author.origin, root };
}

function client(input: AemConfigInput) {
  const authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`;
  return async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${input.author}${path}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: authorization },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`AEM returned HTTP ${response.status}. Check credentials, permissions and the Author URL.`);
    return response;
  };
}

export async function findConfigPages(input: AemConfigInput): Promise<string[]> {
  const request = client(input);
  const pages = new Set<string>();
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({
      path: input.root,
      type: "cq:Page",
      nodename: "ab-config",
      "p.limit": "100",
      "p.offset": String(offset),
      "p.hits": "selective",
      "p.properties": "jcr:path",
      orderby: "path",
    });
    const data: unknown = await (await request(`/bin/querybuilder.json?${query}`)).json();
    if (!data || typeof data !== "object" || !("hits" in data) || !Array.isArray(data.hits) || ("success" in data && data.success === false)) {
      throw new Error("AEM Query Builder returned an invalid or unsuccessful response.");
    }
    const before = pages.size;
    for (const hit of data.hits) {
      const page: unknown = hit?.path ?? hit?.["jcr:path"];
      if (typeof page !== "string" || !(page === input.root || page.startsWith(`${input.root}/`)) || page.split("/").pop() !== "ab-config" || page.slice(1).split("/").some((s) => !s || s === "." || s === "..") || /[?#\\%]/.test(page)) {
        throw new Error("Query Builder returned a page outside the requested ab-config scope.");
      }
      pages.add(page);
    }
    if (!("more" in data) || typeof data.more !== "boolean") throw new Error("Query Builder response is missing pagination information.");
    if (!data.more) return [...pages];
    if (pages.size === before) throw new Error("Query Builder pagination did not advance.");
    offset += data.hits.length;
  }
}

export async function createConfigNodes(input: AemConfigInput, entries: ConfigEntry[]): Promise<ConfigResult[]> {
  if (entries.some((entry) => !entry.value.trim())) throw new Error("Enter a Value for every ab-config page before applying.");
  const request = client(input);
  const results: ConfigResult[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const { page, value } = entries[next++];
      try {
        const parent = `${page}/jcr:content`;
        const encoded = parent.split("/").map(encodeURIComponent).join("/");
        const content: unknown = await (await request(`${encoded}.1.json`)).json();
        if (!content || typeof content !== "object" || !("jcr:primaryType" in content)) throw new Error("Page jcr:content was not found.");
        const existing = Object.entries(content).find(([, node]) =>
          node && typeof node === "object" && "Key" in node && node.Key === CONFIG_KEY,
        );
        if (existing) {
          results.push({ page, status: "exists", node: `${parent}/${existing[0]}`, message: "Key already exists; existing node and value left unchanged." });
          continue;
        }
        const name = `row_${randomUUID().replace(/-/g, "")}`;
        const body = new URLSearchParams({
          "jcr:primaryType": "nt:unstructured",
          Key: CONFIG_KEY,
          Value: value,
          "Key@TypeHint": "String",
          "Value@TypeHint": "String",
        });
        // Basic Auth requests to AEM do not use a browser session or stored credentials.
        await request(`${encoded}/${name}`, { method: "POST", body });
        const saved: unknown = await (await request(`${encoded}/${name}.json`)).json();
        if (!saved || typeof saved !== "object" || !("Key" in saved) || saved.Key !== CONFIG_KEY || !("Value" in saved) || saved.Value !== value || !("jcr:primaryType" in saved) || saved["jcr:primaryType"] !== "nt:unstructured") {
          throw new Error("POST completed but verification failed; inspect the page before retrying.");
        }
        results.push({ page, status: "created", node: `${parent}/${name}`, message: "Created and verified." });
      } catch (error) {
        results.push({ page, status: "failed", node: "", message: error instanceof Error ? error.message : "AEM request failed." });
      }
    }
  }));
  return results.sort((a, b) => a.page.localeCompare(b.page));
}
