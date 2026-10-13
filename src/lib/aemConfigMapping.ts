import type { ConfigPreviewEntry } from "./aemConfig";

export type ConfigEnvironment = "dev" | "test" | "qa" | "prod";

export function isConfigEnvironment(value: unknown): value is ConfigEnvironment {
  return value === "dev" || value === "test" || value === "qa" || value === "prod";
}

export function normalizeContentRoot(root: string): string {
  const normalized = root.trim().replace(/\/+$/, "");
  if (!normalized.startsWith("/content/") || normalized.slice(1).split("/").some((segment) => !segment || segment === "." || segment === "..") || /[?#\\%]/.test(normalized)) {
    throw new Error("Enter a valid content root beneath /content.");
  }
  return normalized;
}

export function domainForEnvironment(domain: string, environment: ConfigEnvironment): string {
  if (environment === "prod") return domain;
  let url: URL;
  try {
    url = new URL(domain.includes("://") ? domain : `https://${domain}`);
  } catch {
    throw new Error(`Cannot derive ${environment} domain from "${domain}".`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname)) {
    throw new Error(`Cannot derive ${environment} domain from "${domain}".`);
  }
  const prefix = { dev: "d1", test: "t1", qa: "q1" }[environment];
  const hostname = url.hostname.replace(/^www\./i, "");
  const pathname = url.pathname === "/" ? "" : url.pathname;
  return `https://www-${prefix}.${hostname}${pathname}${url.search}${url.hash}`;
}

function baseDomain(entry: ConfigPreviewEntry, environment: ConfigEnvironment): string {
  if (entry.sourceDomain && entry.value === domainForEnvironment(entry.sourceDomain, environment)) return entry.sourceDomain;
  if (environment === "prod") return entry.value;
  domainForEnvironment(entry.value, "test");
  const url = new URL(entry.value.includes("://") ? entry.value : `https://${entry.value}`);
  if (!/^www-(d1|t1|q1)\./i.test(url.hostname)) return entry.value;
  const hostname = url.hostname.replace(/^www-(d1|t1|q1)\./i, "");
  const pathname = url.pathname === "/" ? "" : url.pathname;
  return `${hostname}${pathname}${url.search}${url.hash}`;
}

export function switchConfigEnvironment(entries: ConfigPreviewEntry[], from: ConfigEnvironment, to: ConfigEnvironment): ConfigPreviewEntry[] {
  return entries.map((entry) => {
    if (!entry.value.trim()) return entry;
    const sourceDomain = baseDomain(entry, from);
    return { ...entry, sourceDomain, value: domainForEnvironment(sourceDomain, to) };
  });
}

export interface SavedConfig {
  format: "aem-ab-config";
  version: 1;
  environment: ConfigEnvironment;
  root: string;
  mappings: { page: string; domain: string; value: string }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseSavedConfig(data: unknown): SavedConfig {
  if (!isObject(data) || data.format !== "aem-ab-config" || data.version !== 1 || !isConfigEnvironment(data.environment) || typeof data.root !== "string" || !Array.isArray(data.mappings) || data.mappings.length === 0) {
    throw new Error("Invalid config. Load a JSON file created by Save config (version 1).");
  }
  const root = normalizeContentRoot(data.root);
  const seen = new Set<string>();
  const mappings: SavedConfig["mappings"] = [];
  for (const mapping of data.mappings) {
    if (!isObject(mapping) || typeof mapping.page !== "string" || typeof mapping.domain !== "string" || !mapping.domain.trim() || typeof mapping.value !== "string" || !mapping.value.trim()) {
      throw new Error("Every saved mapping needs a page, domain and nonempty Value.");
    }
    if (normalizeContentRoot(mapping.page) !== mapping.page || !(mapping.page === root || mapping.page.startsWith(`${root}/`)) || !mapping.page.endsWith("/ab-config") || seen.has(mapping.page)) {
      throw new Error("Saved pages must be unique ab-config paths within the saved root.");
    }
    domainForEnvironment(mapping.domain, "test");
    domainForEnvironment(mapping.value, "test");
    seen.add(mapping.page);
    mappings.push({ page: mapping.page, domain: mapping.domain, value: mapping.value });
  }
  return { format: "aem-ab-config", version: 1, environment: data.environment, root, mappings };
}

export function saveConfigData(root: string, environment: ConfigEnvironment, entries: ConfigPreviewEntry[]): SavedConfig {
  return parseSavedConfig({
    format: "aem-ab-config",
    version: 1,
    environment,
    root,
    mappings: entries.map((entry) => ({ page: entry.page, domain: baseDomain(entry, environment), value: entry.value })),
  });
}

export function entriesFromConfig(config: SavedConfig): ConfigPreviewEntry[] {
  return config.mappings.map((mapping) => ({
    page: mapping.page,
    value: mapping.value,
    sourceDomain: mapping.domain,
    mappingStatus: "saved",
  }));
}
