import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { AssetMap } from "./assetMap";
import { DEFAULT_UPDATE_OPTIONS, detectLanguageRoots, listPackagePages, updatePackage } from "./aemPackage";

const base = "content/abbvie-nextgen-eds/corporate/abbvie-com";

test("detects partial language-master and country packages without an index page", () => {
  for (const root of [`${base}/language-masters/nl`, `${base}/nl/nl`, `${base}/ca/fr-CA`]) {
    const file = `jcr_root/${root}/news/story/.content.xml`;
    const { roots, pages } = listPackagePages([file, "META-INF/vault/filter.xml"]);
    assert.deepEqual(roots, [root]);
    assert.deepEqual(pages, [{ file, root, path: "/news/story" }]);
  }
});

test("retains existing indexed roots and ignores nested copies", () => {
  const root = `${base}/nl/nl`;
  assert.deepEqual(detectLanguageRoots([
    `jcr_root/${root}/index/.content.xml`,
    `jcr_root/${root}/drafts/nl/nl/index/.content.xml`,
    `jcr_root/${root}/news/.content.xml`,
  ]), [root]);
});

test("detects mixed full and partial language packages without treating assets as pages", () => {
  const full = `${base}/ch/fr`;
  const partial = `${base}/language-masters/nl`;
  assert.deepEqual(new Set(detectLanguageRoots([
    `jcr_root/${full}/index/.content.xml`,
    `jcr_root/${partial}/news/.content.xml`,
    "jcr_root/content/dam/example/.content.xml",
    "jcr_root/content/dam/example/nl/nl/image/.content.xml",
  ])), new Set([full, partial]));
  assert.deepEqual(detectLanguageRoots(["jcr_root/content/example/news/.content.xml"]), []);
  assert.equal(listPackagePages(["jcr_root/content/example/news/.content.xml"], "/content/example/").pages[0].path, "/news");
});

test("updates a partial news package while preserving captions and unrelated entries", () => {
  const root = `${base}/language-masters/nl`;
  const file = `jcr_root/${root}/news/story/.content.xml`;
  const uuid = "11111111-1111-4111-8111-111111111111";
  const image = `urn:aaid:aem:${uuid}`;
  const xml = `<jcr:root><jcr:content><image image="${image}" imageAlt="Old alt" caption="Keep caption"/></jcr:content></jcr:root>`;
  const metadata = "<workspaceFilter version=\"1.0\"/>";
  const result = updatePackage(zipSync({
    [file]: strToU8(xml),
    "META-INF/vault/filter.xml": strToU8(metadata),
  }), new Map([["/news/story", [{
    pagePath: "/news/story", imageUrl: image, edsImagePath: image, altText: "New alt", caption: "",
  }]]]), new AssetMap([{
    uuid, openApiUrl: image,
  }]), { ...DEFAULT_UPDATE_OPTIONS, updateCaption: false, includeFragments: false });
  assert.equal(result.summary.siteRoot, root);
  assert.equal(result.summary.pagesMatched, 1);
  assert.equal(result.summary.fieldsUpdated, 1);
  const output = unzipSync(result.zip);
  assert.equal(strFromU8(output[file]), xml.replace('imageAlt="Old alt"', 'imageAlt="New alt"'));
  assert.equal(strFromU8(output["META-INF/vault/filter.xml"]), metadata);
  assert.deepEqual(Object.keys(output), [file, "META-INF/vault/filter.xml"]);
});
