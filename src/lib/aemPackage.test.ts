import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { AssetMap } from "./assetMap";
import { DEFAULT_UPDATE_OPTIONS, detectLanguageRoots, listPackagePages, updatePackage, type CsvImageRow } from "./aemPackage";
import { parseCsv } from "./csvParse";

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

test("reports shared-image-only pages as unchanged without modifying their content or match counts", () => {
  const roots = [`${base}/nl/nl`, `${base}/language-masters/nl`];
  const image = "urn:aaid:aem:11111111-1111-4111-8111-111111111111";
  const xml = `<jcr:root><jcr:content><image image="${image}" imageAlt="Keep page alt" caption="Keep page caption"/></jcr:content></jcr:root>`;
  const entries: Record<string, Uint8Array> = {};
  const rows = new Map<string, CsvImageRow[]>();
  for (const page of ["one", "two", "three"]) {
    for (const root of roots) {
      entries[`jcr_root/${root}/news/${page}/.content.xml`] = strToU8(xml);
    }
    rows.set(`/news/${page}`, [{
      pagePath: `/news/${page}.html`, imageUrl: image, edsImagePath: image,
      altText: "Shared header alt", caption: "",
    }]);
  }
  const result = updatePackage(zipSync(entries), rows, new AssetMap([]));
  assert.equal(result.changes.length, 6);
  assert.deepEqual(result.summary.byStatus, { unchanged: 6 });
  assert.equal(result.summary.pagesMatched, 3);
  assert.equal(result.summary.headerFooterRows, 3);
  assert.equal(result.summary.imagesMatched, 0);
  assert.equal(result.summary.fieldsUpdated, 0);
  assert.equal(result.summary.filesModified, 0);
  for (const row of result.changes) {
    assert.equal(row.status, "unchanged");
    assert.ok(row.packageFile in entries);
    assert.equal(row.altStatus, "");
    assert.equal(row.captionStatus, "");
    assert.equal(row.node, "");
    assert.match(row.note, /all 1 live image rows were classified as shared header\/footer images/);
  }
  const output = unzipSync(result.zip);
  for (const file of Object.keys(entries)) assert.deepEqual(output[file], entries[file]);
  const report = parseCsv(result.reportCsv);
  assert.equal(report.length, 7);
  assert.ok(report.slice(1).every((row) => row[1] === "unchanged" && row[14].includes("Page content was not modified")));
});

test("does not add a page-level unchanged row when content images have their own outcomes", () => {
  const root = `${base}/language-masters/nl`;
  const shared = "urn:aaid:aem:11111111-1111-4111-8111-111111111111";
  const content = "urn:aaid:aem:22222222-2222-4222-8222-222222222222";
  for (const altText of ["Old alt", "New alt"]) {
    const entries: Record<string, Uint8Array> = {};
    const rows = new Map<string, CsvImageRow[]>();
    for (const page of ["one", "two", "three"]) {
      entries[`jcr_root/${root}/news/${page}/.content.xml`] = strToU8(
        `<jcr:root><jcr:content><image image="${content}" imageAlt="Old alt"/></jcr:content></jcr:root>`,
      );
      rows.set(`/news/${page}`, [{
        pagePath: `/news/${page}.html`, imageUrl: shared, edsImagePath: shared, altText: "Header", caption: "",
      }]);
    }
    rows.get("/news/one")!.push({
      pagePath: "/news/one.html", imageUrl: content, edsImagePath: content, altText, caption: "",
    });
    const result = updatePackage(zipSync(entries), rows, new AssetMap([]));
    const pageRows = result.changes.filter((row) => row.pagePath === "/news/one.html");
    assert.equal(pageRows.length, 1);
    assert.equal(pageRows[0].status, altText === "Old alt" ? "unchanged" : "updated");
    assert.equal(pageRows[0].imageUrl, content);
    assert.equal(result.summary.imagesMatched, 1);
    assert.equal(result.summary.fieldsUpdated, altText === "Old alt" ? 0 : 1);
  }
});
