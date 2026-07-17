import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findPdfCandidates,
  pickBestCandidate,
  rawSnapshotUrl,
  resolveDatasheetPdf,
  snapshotDate,
  type PdfLinkCandidate,
} from "./services/datasheet-resolver.js";

// Pure-parsing tests only — no network, no DB. These exercise the ranking
// logic that decides whether a link on a vendor's HTML page is trustworthy
// enough to follow, which is the part of the resolver that can go wrong
// silently (fetch failures are loud; a wrong-part pick is not).

describe("findPdfCandidates", () => {
  it("scores a link naming the MPN above unrelated PDFs on the same page", () => {
    const html = `
      <html><body>
        <a href="/legal/terms.pdf">Terms of Use</a>
        <a href="/docs/unrelated-part-datasheet.pdf">Datasheet for XYZ9999</a>
        <a href="/docs/MDBT50Q-1MV2-datasheet.pdf">MDBT50Q-1MV2 Datasheet</a>
      </body></html>
    `;
    const candidates = findPdfCandidates(html, "https://www.raytac.com/download/index.php?index_id=43", "MDBT50Q-1MV2");
    const best = pickBestCandidate(candidates);
    expect(best?.url).toBe("https://www.raytac.com/docs/MDBT50Q-1MV2-datasheet.pdf");
    expect(best?.text).toContain("MDBT50Q-1MV2");
  });

  it("resolves relative hrefs against the page URL", () => {
    const html = `<a href="../pdf/nrf52840_ps.pdf">nRF52840 Product Specification</a>`;
    const candidates = findPdfCandidates(
      html,
      "https://docs.nordicsemi.com/bundle/ps_nrf52840/resource/index.html",
      "nRF52840",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.url).toBe("https://docs.nordicsemi.com/bundle/ps_nrf52840/pdf/nrf52840_ps.pdf");
  });

  it("ignores non-PDF links entirely (nav, mailto, anchors, other doc types)", () => {
    const html = `
      <a href="#top">Top</a>
      <a href="mailto:sales@vendor.com">Contact</a>
      <a href="/products/xyz.html">Product page</a>
      <a href="/files/xyz-user-manual.docx">User Manual (Word)</a>
    `;
    const candidates = findPdfCandidates(html, "https://vendor.example/parts/xyz", "XYZ");
    expect(candidates).toHaveLength(0);
  });

  it("falls back to a 'datasheet' keyword match when the MPN is not present in any link", () => {
    const html = `
      <a href="/files/random.pdf">Warranty Card</a>
      <a href="/files/spec-sheet.pdf">Product Datasheet</a>
    `;
    const candidates = findPdfCandidates(html, "https://vendor.example/parts/abc123", "ABC-123");
    const best = pickBestCandidate(candidates);
    expect(best?.url).toBe("https://vendor.example/files/spec-sheet.pdf");
  });

  it("refuses to pick anything when no link has MPN or datasheet-ish signal (governing rule: no guessing)", () => {
    const html = `
      <a href="/files/brochure.pdf">Company Brochure</a>
      <a href="/files/careers.pdf">We're Hiring</a>
    `;
    const candidates = findPdfCandidates(html, "https://vendor.example/parts/abc123", "ABC-123");
    // Both are plausible-looking PDF links, but neither names the part or
    // says "datasheet" — picking either would risk grounding this part from
    // a document about something else entirely.
    expect(pickBestCandidate(candidates)).toBeUndefined();
  });

  it("never picks a Product Brief over the Product Specification beside it", () => {
    // Verbatim from the archived nRF52840 infocenter page — the two links sit in
    // the same <ul>. Both carry the MPN, so on MPN score alone they tie and the
    // winner is whichever the regex saw first. The brief is a marketing summary
    // whose numbers extract just as cleanly as the datasheet's.
    const html = `
      <ul class="sl simple">
        <li><a class="xref" href="http://infocenter.nordicsemi.com/pdf/nRF52840_PB_v2.0.pdf">nRF52840 Product Brief v2.0</a></li>
        <li><a class="xref" href="http://infocenter.nordicsemi.com/pdf/nRF52840_PS_v1.0.pdf">nRF52840 Product Specification v1.0</a></li>
      </ul>`;
    const candidates = findPdfCandidates(
      html,
      "http://infocenter.nordicsemi.com/topic/com.nordic.infocenter.nrf52/dita/nrf52/chips/nrf52840.html",
      "nRF52840",
    );
    expect(pickBestCandidate(candidates)?.url).toBe("http://infocenter.nordicsemi.com/pdf/nRF52840_PS_v1.0.pdf");
  });

  it("refuses a Product Brief even when it is the only PDF on the page", () => {
    // Ranking it second is not enough. A brief is not the datasheet, so the
    // honest outcome is "we did not find it" — not "we found something nearby".
    const html = `<a href="/pdf/nRF52840_PB_v2.0.pdf">nRF52840 Product Brief v2.0</a>`;
    const candidates = findPdfCandidates(html, "http://infocenter.nordicsemi.com/x.html", "nRF52840");
    expect(pickBestCandidate(candidates)).toBeUndefined();
  });

  it("returns an empty list, not a throw, for a page with no anchors at all", () => {
    expect(findPdfCandidates("<html><body>no links here</body></html>", "https://vendor.example/", "ABC")).toEqual(
      [],
    );
  });
});

describe("rawSnapshotUrl", () => {
  it("rewrites a Wayback snapshot to serve the archived bytes, not the viewer", () => {
    // Without id_ the archive returns the page wrapped in its toolbar with every
    // href rewritten to point back into web.archive.org — so candidate links
    // would resolve against the archive instead of the vendor. It fails
    // silently: the fetch succeeds and the page looks right.
    expect(
      rawSnapshotUrl("http://web.archive.org/web/20240314015350/https://infocenter.nordicsemi.com/pdf/nRF52840_PS_v1.0.pdf"),
    ).toBe("http://web.archive.org/web/20240314015350id_/https://infocenter.nordicsemi.com/pdf/nRF52840_PS_v1.0.pdf");
  });

  it("leaves an already-raw snapshot alone", () => {
    const raw = "http://web.archive.org/web/20220614005024id_/https://example.com/a.pdf";
    expect(rawSnapshotUrl(raw)).toBe(raw);
  });

  it("does not mangle a URL that is not a snapshot", () => {
    expect(rawSnapshotUrl("https://vendor.example/ds.pdf")).toBe("https://vendor.example/ds.pdf");
  });
});

describe("snapshotDate", () => {
  it("reads a Wayback timestamp as a date a person can weigh", () => {
    // The age of the copy is part of the audit trail: a 2019 snapshot of a
    // v1.0 datasheet is honest data, but a human should be able to see it is
    // not the current revision.
    expect(snapshotDate("20240314015350")).toBe("2024-03-14");
  });

  it("passes through anything it cannot parse rather than inventing a date", () => {
    expect(snapshotDate("")).toBe("");
  });
});

/**
 * The archive ladder, driven through a stubbed fetch. Network-bound logic that
 * took three passes to get right against the real nRF52840, so it is pinned
 * rather than left to be rediscovered: every failure mode here answers HTTP 200.
 */
describe("resolveDatasheetPdf archive fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  const PDF = Buffer.from("%PDF-1.4 real datasheet bytes");
  const TOPIC = "http://vendor.example/chips/part.html";
  const PS_PDF = "http://vendor.example/pdf/PART1_PS_v1.0.pdf";

  /** a fetch built from an exact url→response map, so every hop is explicit */
  function stubFetch(routes: Record<string, { status?: number; body: Buffer | string; type?: string }>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = routes[url];
      if (!hit) return new Response("not found", { status: 404 });
      const body = typeof hit.body === "string" ? hit.body : new Uint8Array(hit.body);
      return new Response(body, {
        status: hit.status ?? 200,
        headers: { "content-type": hit.type ?? "application/octet-stream" },
      });
    });
    return calls;
  }

  function availability(target: string, snapshot: string, timestamp: string) {
    return {
      [`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`]: {
        body: JSON.stringify({
          archived_snapshots: { closest: { available: true, url: snapshot, timestamp, status: "200" } },
        }),
        type: "application/json",
      },
    };
  }

  it("falls back to the archive when the vendor answers 200 with a page where a PDF was promised", async () => {
    // The nRF52840 shape end to end. Nordic's topic page answers 200 with a
    // redirect stub carrying no links, and the PS url answers 200 with another
    // stub instead of the file — so nothing here is an HTTP error, and a
    // resolver that trusts status codes gives up with the PDF sitting in reach.
    const snapTopic = "http://web.archive.org/web/20190403211446id_/" + TOPIC;
    const snapPdf = "http://web.archive.org/web/20240314015350id_/" + PS_PDF;
    const calls = stubFetch({
      [TOPIC]: { body: "<html><script>window.location.replace('/new')</script></html>", type: "text/html" },
      [PS_PDF]: { body: "<html>moved</html>", type: "text/html" },
      ...availability(TOPIC, snapTopic.replace("id_/", "/"), "20190403211446"),
      ...availability(PS_PDF, snapPdf.replace("id_/", "/"), "20240314015350"),
      [snapTopic]: {
        body: `<ul><li><a href="${PS_PDF}">PART1 Product Specification v1.0</a></li></ul>`,
        type: "text/html",
      },
      [snapPdf]: { body: PDF, type: "application/pdf" },
    });

    const got = await resolveDatasheetPdf(TOPIC, "PART1");
    expect(got.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(got.url).toBe(PS_PDF);
    // the reason must name the archive and its date — provenance is the product
    expect(got.reason).toContain("Internet Archive");
    expect(got.reason).toContain("2024-03-14");
    // and it must have asked the vendor first, both times
    expect(calls[0]).toBe(TOPIC);
    expect(calls).toContain(PS_PDF);
  });

  it("never touches the archive when the vendor serves the PDF itself", async () => {
    const calls = stubFetch({ [PS_PDF]: { body: PDF, type: "application/pdf" } });
    const got = await resolveDatasheetPdf(PS_PDF, "PART1");
    expect(got.reason).toBe("recorded URL served a PDF from vendor");
    expect(calls).toEqual([PS_PDF]);
  });

  it("reports the vendor's own error when the archive has nothing either", async () => {
    // "hoperf.com returned 404" is a far more useful thing to read than
    // "no archived copy", so the original failure must survive.
    stubFetch({ [PS_PDF]: { status: 404, body: "gone" } });
    await expect(resolveDatasheetPdf(PS_PDF, "PART1")).rejects.toThrow(/404/);
  });

  it("refuses an archived snapshot the archive recorded as an error page", async () => {
    // The archive faithfully stores 403 challenge pages too. Replaying one as
    // though it were a datasheet is the exact failure being fixed here.
    stubFetch({
      [PS_PDF]: { status: 403, body: "blocked" },
      [`https://archive.org/wayback/available?url=${encodeURIComponent(PS_PDF)}`]: {
        body: JSON.stringify({
          archived_snapshots: { closest: { available: true, url: "http://web.archive.org/web/1/x", status: "403" } },
        }),
        type: "application/json",
      },
    });
    await expect(resolveDatasheetPdf(PS_PDF, "PART1")).rejects.toThrow(/no usable copy/);
  });
});

describe("pickBestCandidate", () => {
  it("is undefined for an empty candidate list", () => {
    expect(pickBestCandidate([])).toBeUndefined();
  });

  it("picks the single highest-scoring candidate when several clear the bar", () => {
    const candidates: PdfLinkCandidate[] = [
      { url: "https://vendor.example/manual.pdf", text: "User Manual", score: 5 },
      { url: "https://vendor.example/ds.pdf", text: "Datasheet", score: 20 },
      { url: "https://vendor.example/part-mpn.pdf", text: "MPN123 full datasheet", score: 120 },
    ];
    expect(pickBestCandidate(candidates)?.url).toBe("https://vendor.example/part-mpn.pdf");
  });
});
