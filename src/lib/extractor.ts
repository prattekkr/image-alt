export interface RawImage {
  src: string;
  alt: string | null;
  caption: string;
  captionSource: string;
  width: number;
  height: number;
  /** DAM asset path exposed by the CMS (e.g. AEM's data-asset), if any. */
  damPath: string;
}

/**
 * Extracts images from a document. This function is serialised and injected into the browser,
 * so it must stay fully self-contained (no references to anything outside its body).
 * Works on the live `document` as well as on HTML parsed with DOMParser.
 */
export function extractImagesFromDocument(doc: Document, baseUrl: string): RawImage[] {
  const decoder = doc.createElement("textarea");
  const decode = (s: string) => {
    // Some CMSs double-encode entities in alt text (e.g. "parkinson&#39;s").
    if (!/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) return s;
    decoder.innerHTML = s;
    return decoder.value;
  };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const absolute = (u: string) => {
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return u;
    }
  };
  const srcOf = (img: HTMLImageElement) => {
    // AEM Core Image keeps the real URL on the wrapper while the <img> shows a placeholder. It is a
    // template like "...?ts=1&dpr=on,{dpr}" or "...coreimg{.width}.jpg"; drop the placeholders.
    const wrapperSrc = img
      .closest("[data-cmp-src]")
      ?.getAttribute("data-cmp-src")
      ?.replace(/[,&]?\{[^}]*\}/g, "")
      .replace(/[?&]$/, "");
    const candidates = [
      img.currentSrc,
      img.getAttribute("data-src"),
      img.getAttribute("data-lazy-src"),
      img.getAttribute("data-original"),
      img.getAttribute("src"),
      (img.getAttribute("srcset") || img.getAttribute("data-srcset") || "").split(",")[0]?.trim().split(/\s+/)[0],
      wrapperSrc,
    ];
    const real = candidates.find((c) => c && !c.startsWith("data:"));
    return real ? absolute(real) : "";
  };
  /**
   * The caption is AEM's itemprop="caption" on the image component, in a wrapper that belongs only to
   * this image: <meta itemprop="caption" content="…"> when the caption is hidden, or
   * <span class="cmp-image__title" itemprop="caption">…</span> when it is displayed.
   * Nothing else (title, data-title, figcaption…) is used.
   */
  const findCaption = (img: HTMLImageElement): [string, string] => {
    const thisSrc = srcOf(img);
    let el: HTMLElement | null = img.parentElement;
    for (let depth = 0; depth < 4 && el && el !== doc.body; depth++) {
      const otherImages = Array.from(el.querySelectorAll("img")).some((o) => srcOf(o) !== thisSrc);
      if (otherImages) break;
      const cap = el.querySelector('[itemprop="caption"]');
      if (cap) {
        return cap.tagName === "META"
          ? [clean(cap.getAttribute("content")), "meta itemprop=caption"]
          : [clean((cap as HTMLElement).innerText || cap.textContent), "itemprop=caption (displayed)"];
      }
      el = el.parentElement;
    }
    return ["", ""];
  };

  const allImages = Array.from(doc.querySelectorAll("img"));
  // In DOMParser documents, <noscript> content is parsed as real elements. Lazy-loading components
  // (e.g. AEM Core Image) ship the only copy of the image there, so keep those unless the same
  // image also exists outside <noscript>.
  const liveSources = new Set(allImages.filter((i) => !i.closest("noscript")).map(srcOf));

  const out: RawImage[] = [];
  allImages.forEach((img) => {
    const src = srcOf(img);
    if (!src) return;
    if (img.closest("noscript") && liveSources.has(src)) return;
    const shownSrc = img.currentSrc || img.getAttribute("src") || "";
    const isTrackingPixel =
      // Ignore 1x1 data: placeholders that lazy loaders show before swapping in the real image.
      (!shownSrc.startsWith("data:") && img.complete && img.naturalWidth > 0 && img.naturalWidth <= 1 && img.naturalHeight <= 1) ||
      (img.getAttribute("width") === "1" && img.getAttribute("height") === "1");
    if (isTrackingPixel) return;
    const altAttr = img.getAttribute("alt");
    const [caption, captionSource] = findCaption(img);
    const loadedReal = !shownSrc.startsWith("data:");
    const component = img.closest("[data-cmp-is='image'], .cmp-image, [data-asset]");
    out.push({
      src,
      alt: altAttr === null ? null : clean(decode(altAttr)),
      caption: decode(caption),
      captionSource,
      width: (loadedReal && (img.naturalWidth || img.width)) || Number(img.getAttribute("width")) || 0,
      height: (loadedReal && (img.naturalHeight || img.height)) || Number(img.getAttribute("height")) || 0,
      damPath: clean(img.getAttribute("data-asset") || component?.getAttribute("data-asset")),
    });
  });
  return out;
}
