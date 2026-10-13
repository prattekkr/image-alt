import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_KEY, createConfigNodes, domainForEnvironment, findConfigPages, loadConfigEntries, loadPreviewMappings, persistConfig, populateConfigEntries, SAVED_CONFIG_NAME, validateConfigInput } from "./aemConfig";
import { POST } from "../app/api/aem-config/route";
import { entriesFromConfig, parseSavedConfig, saveConfigData, switchConfigEnvironment } from "./aemConfigMapping";

const input = validateConfigInput({
  author: "http://localhost:4502",
  username: "test-user",
  password: "test-password",
  root: "/content/example",
});
const value = "https://www.abbvie.ch/fr";
const entriesFor = (pages: string[]) => pages.map((page) => ({ page, value }));

test("validates the Author URL, root and credentials without requiring a configuration Value", () => {
  assert.equal(validateConfigInput({ ...input, root: "/content/example/" }).root, "/content/example");
  for (const author of ["http://author.example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x=1"]) {
    assert.throws(() => validateConfigInput({ ...input, author }));
  }
  for (const root of ["/", "/content", "/content/x/../y", "/content//x", "/content/%2e%2e/x"]) {
    assert.throws(() => validateConfigInput({ ...input, root }));
  }
  assert.throws(() => validateConfigInput({ ...input, password: "" }));
});

test("Query Builder paginates, passes Basic Auth and returns only scoped pages", async (t) => {
  const offsets: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
    assert.equal(init.redirect, "error");
    const query = new URL(url).searchParams;
    assert.equal(query.get("type"), "cq:Page");
    assert.equal(query.get("nodename"), "ab-config");
    assert.equal(query.get("path"), input.root);
    offsets.push(query.get("p.offset")!);
    const more = offsets.length === 1;
    return Response.json({ success: true, more, hits: [{ path: `${input.root}/${more ? "a" : "b"}/ab-config` }] });
  });
  assert.deepEqual(await findConfigPages(input), ["/content/example/a/ab-config", "/content/example/b/ab-config"]);
  assert.deepEqual(offsets, ["0", "1"]);
});

test("rejects unsuccessful, out-of-scope and stalled query responses", async (t) => {
  for (const response of [
    { success: false, hits: [], more: false },
    { hits: [{ path: "/content/other/ab-config" }], more: false },
    { hits: [], more: true },
    { hits: [] },
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(response));
    await assert.rejects(findConfigPages(input));
    mock.mock.restore();
  }
});

test("creates exact typed properties, verifies writes, skips existing keys and reports partial failures", async (t) => {
  const posts: { url: string; body: URLSearchParams }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("/denied/")) return new Response("", { status: 403 });
    if (init.method === "POST") {
      posts.push({ url, body: new URLSearchParams(String(init.body)) });
      return new Response("", { status: 201 });
    }
    if (url.endsWith(".1.json")) {
      return Response.json({
        "jcr:primaryType": "cq:PageContent",
        ...(url.includes("/existing/") ? { row_123: { Key: CONFIG_KEY, Value: "old-value" } } : {}),
      });
    }
    return Response.json({ "jcr:primaryType": "nt:unstructured", Key: CONFIG_KEY, Value: value });
  });
  const result = await createConfigNodes(input, entriesFor(["new", "existing", "denied"].map((name) => `${input.root}/${name}/ab-config`)));
  assert.deepEqual(result.map((r) => r.status), ["failed", "exists", "created"]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/jcr%3Acontent\/row_[a-f0-9]{32}$/);
  assert.deepEqual(Object.fromEntries(posts[0].body), {
    "jcr:primaryType": "nt:unstructured",
    Key: CONFIG_KEY,
    Value: value,
    "Key@TypeHint": "String",
    "Value@TypeHint": "String",
  });
  assert.match(result[0].message, /403/);
  assert.match(result[1].message, /left unchanged/);
});

test("does not report an unverified write as success", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") return new Response("", { status: 201 });
    return Response.json({ "jcr:primaryType": "cq:PageContent" });
  });
  const [result] = await createConfigNodes(input, entriesFor([`${input.root}/ab-config`]));
  assert.equal(result.status, "failed");
  assert.match(result.message, /verification failed/);
});

test("limits writes to four concurrent workers", async (t) => {
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (init.method === "POST") return new Response("", { status: 201 });
    return Response.json(url.endsWith(".1.json") ? { "jcr:primaryType": "cq:PageContent" } : {
      "jcr:primaryType": "nt:unstructured", Key: CONFIG_KEY, Value: value,
    });
  });
  const results = await createConfigNodes(input, entriesFor(Array.from({ length: 10 }, (_, i) => `${input.root}/${i}/ab-config`)));
  assert.equal(results.filter((r) => r.status === "created").length, 10);
  assert.equal(maximum, 4);
});

test("API previews without writes and rejects selections outside the discovered scope", async (t) => {
  let writes = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") writes++;
    return Response.json({ success: true, more: false, hits: [{ path: `${input.root}/ab-config` }] });
  });
  const call = (body: unknown) => POST(new Request("http://localhost/api/aem-config", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }));
  const preview = await call({ ...input, action: "preview" });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    pages: [`${input.root}/ab-config`],
    entries: [{ page: `${input.root}/ab-config`, value: "", mappingStatus: "unmatched" }],
    mappingSource: SAVED_CONFIG_NAME,
  });
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const invalid = await call({ ...input, action: "apply", entries: entriesFor(["/content/other/ab-config"]) });
  assert.equal(invalid.status, 400);
  assert.equal(writes, 0);
  assert.equal((await call({ ...input, action: "delete" })).status, 400);
  assert.equal((await call({ ...input, username: 1, action: "preview" })).status, 400);
});

test("API applies different values to their corresponding pages in a single request", async (t) => {
  const entries = [
    { page: `${input.root}/ch/fr/ab-config`, value: "https://www.abbvie.ch/fr" },
    { page: `${input.root}/nz/en/ab-config`, value: "https://www.abbvie.co.nz" },
  ];
  const writes = new Map<string, string>();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("/bin/querybuilder")) return Response.json({ success: true, more: false, hits: entries.map(({ page }) => ({ path: page })) });
    if (init.method === "POST") {
      writes.set(url, new URLSearchParams(String(init.body)).get("Value")!);
      return new Response("", { status: 201 });
    }
    return Response.json(url.endsWith(".1.json") ? { "jcr:primaryType": "cq:PageContent" } : {
      "jcr:primaryType": "nt:unstructured", Key: CONFIG_KEY, Value: writes.get(url.replace(/\.json$/, "")),
    });
  });
  const response = await POST(new Request("http://localhost/api/aem-config", {
    method: "POST", body: JSON.stringify({ ...input, action: "apply", entries }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  assert.ok(body.results.every((result: { status: string }) => result.status === "created"));
  for (const entry of entries) {
    assert.equal([...writes].find(([url]) => url.includes(`${entry.page}/`))?.[1], entry.value);
  }
  assert.ok(!JSON.stringify(body).includes(input.password));
});

test("API rejects incomplete, duplicate and malformed batches before any writes", async (t) => {
  let writes = 0;
  const page = `${input.root}/ab-config`;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") writes++;
    return Response.json({ success: true, more: false, hits: [{ path: page }] });
  });
  for (const entries of [
    [],
    [{ page, value: " " }],
    [{ page, value: 123 }],
    [{ page, value }, { page, value: "different" }],
    [{ page, value }, { page: `${input.root}/other/ab-config`, value: "" }],
  ]) {
    const response = await POST(new Request("http://localhost/api/aem-config", {
      method: "POST", body: JSON.stringify({ ...input, action: "apply", entries }),
    }));
    assert.equal(response.status, 400);
    assert.equal(writes, 0);
  }
});

test("matches exact contentPath parents and copies domains without adding or removing URL parts", () => {
  const entries = populateConfigEntries([
    "/content/example/us/en/ab-config",
    "/content/example/ch/fr/ab-config",
    "/content/example/us/en/nested/ab-config",
    "/content/example/us/en-other/ab-config",
  ], { sites: [
    { domain: "abbvie.com", contentPath: "/content/example/us/en/" },
    { domain: "https://www.abbvie.ch/fr", contentPath: "/content/example/ch/fr" },
  ] });
  assert.deepEqual(entries.map(({ value, mappingStatus }) => ({ value, mappingStatus })), [
    { value: "abbvie.com", mappingStatus: "matched" },
    { value: "https://www.abbvie.ch/fr", mappingStatus: "matched" },
    { value: "", mappingStatus: "unmatched" },
    { value: "", mappingStatus: "unmatched" },
  ]);
});

test("conflicting domains remain blank, while identical duplicate mappings are safe", () => {
  const site = { domain: "abbvie.com", contentPath: "/content/example/us/en" };
  const page = `${site.contentPath}/ab-config`;
  assert.equal(populateConfigEntries([page], { sites: [site, site] })[0].value, "abbvie.com");
  assert.deepEqual(populateConfigEntries([page], { sites: [site, { ...site, domain: "other.example.com" }] }), [
    { page, value: "", mappingStatus: "ambiguous" },
  ]);
});

test("invalid mapping data fails explicitly", () => {
  for (const data of [
    null, {}, { sites: {} }, { sites: [null] },
    { sites: [{ domain: "", contentPath: "/content/example" }] },
    { sites: [{ domain: "abbvie.com", contentPath: "/content/../example" }] },
  ]) assert.throws(() => populateConfigEntries([], data), /sites.json/);
});

test("queries Author then automatically populates only its US page from the server config", async (t) => {
  const page = "/content/abbvie-nextgen-eds/corporate/abbvie-com/us/en/ab-config";
  assert.deepEqual(await loadConfigEntries([page]), [{ page, sourceDomain: "abbvie.com", value: "abbvie.com", mappingStatus: "matched" }]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, more: false, hits: [{ path: page }] }));
  const response = await POST(new Request("http://localhost/api/aem-config", {
    method: "POST", body: JSON.stringify({ ...input, root: "/content/abbvie-nextgen-eds", action: "preview" }),
  }));
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.mappingSource, SAVED_CONFIG_NAME);
  assert.deepEqual(preview.entries, [{ page, sourceDomain: "abbvie.com", value: "abbvie.com", mappingStatus: "saved" }]);
});

test("derives the required environment URLs while keeping Prod exactly unchanged", () => {
  assert.equal(domainForEnvironment("abbvie.com", "dev"), "https://www-d1.abbvie.com");
  assert.equal(domainForEnvironment("abbvie.com", "test"), "https://www-t1.abbvie.com");
  assert.equal(domainForEnvironment("abbvie.com", "qa"), "https://www-q1.abbvie.com");
  assert.equal(domainForEnvironment("abbvie.com", "prod"), "abbvie.com");
  assert.equal(domainForEnvironment("abbvie.co.nz", "test"), "https://www-t1.abbvie.co.nz");
  assert.equal(domainForEnvironment("www.abbvie.com", "dev"), "https://www-d1.abbvie.com");
  assert.equal(domainForEnvironment("https://www.abbvie.ch/fr", "qa"), "https://www-q1.abbvie.ch/fr");
  assert.equal(domainForEnvironment("https://www.abbvie.ch/fr", "prod"), "https://www.abbvie.ch/fr");
  assert.throws(() => domainForEnvironment("not a domain", "test"), /Cannot derive test domain/);
  assert.throws(() => domainForEnvironment("ftp://abbvie.com", "qa"), /Cannot derive qa domain/);
});

test("API discovery applies the selected environment and rejects unknown environments", async (t) => {
  const page = "/content/abbvie-nextgen-eds/corporate/abbvie-com/us/en/ab-config";
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    queries++;
    return Response.json({ success: true, more: false, hits: [{ path: page }] });
  });
  for (const [environment, expected] of [
    ["dev", "https://www-d1.abbvie.com"],
    ["test", "https://www-t1.abbvie.com"],
    ["qa", "https://www-q1.abbvie.com"],
    ["prod", "abbvie.com"],
  ]) {
    const response = await POST(new Request("http://localhost/api/aem-config", {
      method: "POST", body: JSON.stringify({ ...input, root: "/content/abbvie-nextgen-eds", action: "preview", environment }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).entries, [{ page, sourceDomain: "abbvie.com", value: expected, mappingStatus: "saved" }]);
  }
  const response = await POST(new Request("http://localhost/api/aem-config", {
    method: "POST", body: JSON.stringify({ ...input, action: "preview", environment: "staging" }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Choose an environment/);
  assert.equal(queries, 4);
});

test("saves and reloads mappings without credentials and retains exact original Prod domain formatting", () => {
  const pages = [`${input.root}/us/en/ab-config`, `${input.root}/ch/fr/ab-config`];
  const entries = populateConfigEntries(pages, { sites: [
    { domain: "abbvie.com", contentPath: `${input.root}/us/en` },
    { domain: "https://www.abbvie.ch/fr", contentPath: `${input.root}/ch/fr` },
  ] }, "dev");
  const saved = saveConfigData(input.root, "dev", entries);
  assert.deepEqual(Object.keys(saved).sort(), ["environment", "format", "mappings", "root", "version"]);
  const loaded = parseSavedConfig(JSON.parse(JSON.stringify({ ...saved, username: "ignored", password: "ignored", author: "ignored" })));
  assert.ok(!JSON.stringify(loaded).includes("ignored"));
  const restored = entriesFromConfig(loaded);
  assert.deepEqual(restored.map((entry) => entry.value), ["https://www-d1.abbvie.com", "https://www-d1.abbvie.ch/fr"]);
  const testEntries = switchConfigEnvironment(restored, "dev", "test");
  assert.deepEqual(testEntries.map((entry) => entry.value), ["https://www-t1.abbvie.com", "https://www-t1.abbvie.ch/fr"]);
  const qaEntries = switchConfigEnvironment(testEntries, "test", "qa");
  const prodEntries = switchConfigEnvironment(qaEntries, "qa", "prod");
  assert.deepEqual(prodEntries.map((entry) => entry.value), ["abbvie.com", "https://www.abbvie.ch/fr"]);
  assert.deepEqual(switchConfigEnvironment(prodEntries, "prod", "dev").map((entry) => entry.value), entries.map((entry) => entry.value));
});

test("manual domain edits survive save/load and environment switches without double prefixes", () => {
  const entry = {
    page: `${input.root}/ch/fr/ab-config`,
    sourceDomain: "abbvie.ch",
    mappingStatus: "matched" as const,
    value: "https://www-d1.custom.example.com/fr",
  };
  const config = saveConfigData(input.root, "dev", [entry]);
  assert.equal(config.mappings[0].domain, "custom.example.com/fr");
  assert.equal(entriesFromConfig(config)[0].value, entry.value);
  const switched = switchConfigEnvironment(entriesFromConfig(config), "dev", "test");
  assert.equal(switched[0].value, "https://www-t1.custom.example.com/fr");
  assert.equal(switchConfigEnvironment(switched, "test", "qa")[0].value, "https://www-q1.custom.example.com/fr");
  assert.equal(switchConfigEnvironment(switched, "test", "prod")[0].value, "custom.example.com/fr");
  assert.equal(switchConfigEnvironment([{ ...entry, value: "" }], "dev", "test")[0].value, "");
});

test("rejects invalid saved config schemas, empty values, duplicates and out-of-root pages", () => {
  const saved = saveConfigData(input.root, "prod", [{
    page: `${input.root}/ab-config`, value: "abbvie.com", sourceDomain: "abbvie.com", mappingStatus: "matched",
  }]);
  for (const config of [
    null,
    { ...saved, version: 2 },
    { ...saved, environment: "staging" },
    { ...saved, mappings: [] },
    { ...saved, mappings: [{ ...saved.mappings[0], value: "" }] },
    { ...saved, mappings: [saved.mappings[0], saved.mappings[0]] },
    { ...saved, mappings: [{ ...saved.mappings[0], page: "/content/other/ab-config" }] },
    { ...saved, mappings: [{ ...saved.mappings[0], page: `${input.root}/../ab-config` }] },
    { ...saved, mappings: [{ ...saved.mappings[0], domain: "not a domain" }] },
  ]) assert.throws(() => parseSavedConfig(config));
});

test("uses saved overrides for queried pages only, ignoring saved pages absent on target Author", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aem-config-test-"));
  const file = path.join(directory, SAVED_CONFIG_NAME);
  const siteFile = path.join(directory, "sites.json");
  const originalDirectory = process.cwd();
  let savedFileExists = false;
  const currentPage = `${input.root}/us/en/ab-config`;
  const absentPage = `${input.root}/old/en/ab-config`;
  const unmatchedPage = `${input.root}/new/en/ab-config`;
  const config = saveConfigData(input.root, "dev", [
    { page: currentPage, value: "https://www-d1.custom.example.com/fr", mappingStatus: "saved", sourceDomain: "custom.example.com/fr" },
    { page: absentPage, value: "https://www-d1.old.example.com", mappingStatus: "saved", sourceDomain: "old.example.com" },
  ]);
  await writeFile(siteFile, JSON.stringify({ sites: [{
    domain: "abbvie.co.nz", contentPath: "/content/abbvie-nextgen-eds/corporate/abbvie-com/nz/en",
  }] }));
  try {
    process.chdir(directory);
    await persistConfig(config);
    savedFileExists = true;
    const preview = await loadPreviewMappings([currentPage, unmatchedPage], "test");
    assert.equal(preview.mappingSource, SAVED_CONFIG_NAME);
    assert.deepEqual(preview.entries, [
      { page: currentPage, value: "https://www-t1.custom.example.com/fr", sourceDomain: "custom.example.com/fr", mappingStatus: "saved" },
      { page: unmatchedPage, value: "", mappingStatus: "unmatched" },
    ]);
    assert.ok(!preview.entries.some((entry) => entry.page === absentPage));
    const sameEnvironment = await loadPreviewMappings([currentPage], "dev");
    assert.equal(sameEnvironment.entries[0].value, config.mappings[0].value);
    const sitePage = "/content/abbvie-nextgen-eds/corporate/abbvie-com/nz/en/ab-config";
    const withSiteFallback = await loadPreviewMappings([currentPage, sitePage], "qa");
    assert.equal(withSiteFallback.entries[1].value, "https://www-q1.abbvie.co.nz");
    assert.equal(withSiteFallback.entries[1].mappingStatus, "matched");
    await unlink(file);
    savedFileExists = false;
    const withoutConfig = await loadPreviewMappings([sitePage], "test");
    assert.equal(withoutConfig.mappingSource, "sites.json");
    assert.equal(withoutConfig.entries[0].value, "https://www-t1.abbvie.co.nz");
  } finally {
    process.chdir(originalDirectory);
    if (savedFileExists) await unlink(file);
    await unlink(siteFile);
    await rmdir(directory);
  }
});

test("persists config atomically, excludes credentials and rejects bad files without silent fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aem-config-test-"));
  const file = path.join(directory, SAVED_CONFIG_NAME);
  const originalDirectory = process.cwd();
  const config = saveConfigData(input.root, "prod", [{
    page: `${input.root}/ab-config`, value: "abbvie.com", mappingStatus: "matched",
  }]);
  try {
    process.chdir(directory);
    await persistConfig({ ...config, ...{ username: "private-user", password: "private-password" } });
    const text = await readFile(file, "utf8");
    assert.deepEqual(JSON.parse(text), config);
    assert.ok(!text.includes("private"));
    await assert.rejects(persistConfig({ ...config, root: "/" }));
    assert.equal(await readFile(file, "utf8"), text);
    await persistConfig({ ...config, environment: "test" });
    assert.equal(JSON.parse(await readFile(file, "utf8")).environment, "test");
    assert.deepEqual(await readdir(directory), [SAVED_CONFIG_NAME]);
    await writeFile(file, "{invalid", "utf8");
    await assert.rejects(loadPreviewMappings([`${input.root}/ab-config`], "qa"));
  } finally {
    process.chdir(originalDirectory);
    await unlink(file);
    await rmdir(directory);
  }
});

test("save-config API rejects invalid data without querying Author or writing a config", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  const response = await POST(new Request("http://localhost/api/aem-config", {
    method: "POST", body: JSON.stringify({ action: "save-config", config: { version: 99 } }),
  }));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("Save config API persists a reference automatically reused after querying the target Author", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aem-config-test-"));
  const originalDirectory = process.cwd();
  const page = `${input.root}/ab-config`;
  const config = saveConfigData(input.root, "dev", [{
    page, value: "https://www-d1.saved.example.com", sourceDomain: "saved.example.com", mappingStatus: "saved",
  }]);
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    queries++;
    return Response.json({ success: true, more: false, hits: [{ path: page }] });
  });
  try {
    process.chdir(directory);
    const saved = await POST(new Request("http://localhost/api/aem-config", {
      method: "POST", body: JSON.stringify({ action: "save-config", config }),
    }));
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { saved: SAVED_CONFIG_NAME });
    assert.equal(queries, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, SAVED_CONFIG_NAME), "utf8")), config);
    const preview = await POST(new Request("http://localhost/api/aem-config", {
      method: "POST", body: JSON.stringify({ ...input, action: "preview", environment: "test" }),
    }));
    assert.equal(preview.status, 200);
    const data = await preview.json();
    assert.equal(queries, 1);
    assert.equal(data.mappingSource, SAVED_CONFIG_NAME);
    assert.deepEqual(data.entries, [{ page, value: "https://www-t1.saved.example.com", sourceDomain: "saved.example.com", mappingStatus: "saved" }]);
  } finally {
    process.chdir(originalDirectory);
    await unlink(path.join(directory, SAVED_CONFIG_NAME));
    await rmdir(directory);
  }
});
