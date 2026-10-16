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

test("never updates or adds cardImageAlt while updating the same asset's content alt and caption", () => {
  const root = `${base}/nl/nl`;
  const uuid = "11111111-1111-4111-8111-111111111111";
  const image = `urn:aaid:aem:${uuid}`;
  const assets = new AssetMap([{ uuid, openApiUrl: image }]);
  for (const oldAlt of [' cardImageAlt="Original teaser"', ""]) {
    const file = `jcr_root/${root}/nieuws/GPTW/.content.xml`;
    const xml = `<jcr:root><jcr:content cardImage="${image}"${oldAlt} modelFields="[cardImageAlt@String]"><image image="${image}" imageAlt="Old alt" caption="Old caption"/><teaser cardImage="${image}"${oldAlt}/></jcr:content></jcr:root>`;
    const options = { ...DEFAULT_UPDATE_OPTIONS, includeCardImage: true };
    const result = updatePackage(zipSync({ [file]: strToU8(xml) }), new Map([["/nieuws/gptw", [{
      pagePath: "/nieuws/GPTW.html", imageUrl: image, edsImagePath: image,
      altText: "Group of employees showing award", caption: "New caption",
    }]]]), assets, options);
    assert.equal(strFromU8(unzipSync(result.zip)[file]), xml
      .replace('imageAlt="Old alt"', 'imageAlt="Group of employees showing award"')
      .replace('caption="Old caption"', 'caption="New caption"'));
    assert.equal(result.summary.imagesMatched, 1);
    assert.equal(result.summary.fieldsUpdated, 2);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].altField, "imageAlt");
    assert.ok(!result.changes.some((row) => row.altField === "cardImageAlt"));
  }
});
