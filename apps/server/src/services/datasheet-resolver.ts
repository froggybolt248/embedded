/**
 * Turning the URL KiCad recorded into actual PDF bytes, trying progressively
 * harder before giving up.
 *
 * `deepen.ts`'s original `fetchPdf` did exactly step 1 below: fetch the
 * recorded URL, check the `%PDF-` magic bytes. That is correct as far as it
 * goes but stops at the first vendor page that isn't itself a PDF — and on
 * this library's real 22k parts that is common: Raytac's datasheet link is a
 * download PORTAL (`raytac.com/download/index.php?index_id=43`), and plenty
 * of other vendors serve a product page that merely LINKS to the PDF rather
 * than being one. Step 2 below handles that shape: parse the HTML, find the
 * link that actually names this part's datasheet, fetch and verify that.
 *
 * Step 3 is the Internet Archive, and it is what makes "every part grounds"
 * true rather than aspirational. Measured live (2026-07-17) against this
 * library's real failures, it is the ONLY mechanism that fixes the ones no
 * amount of resolver cleverness could, because it stops asking the vendor:
 *
 *   - nRF52840: Nordic answers 403 to any programmatic request, on both the
 *     infocenter URL KiCad records and its docs.nordicsemi.com replacement.
 *     It is a Cloudflare bot challenge, not a broken link, and no header makes
 *     it pass. The archive serves the same PDF: 10,711,568 bytes, `%PDF-`.
 *   - BME280 / BMP280: `ae-bst.resource.bosch.com` no longer resolves in DNS
 *     at all — there is no server left to be clever with. Archive: 1,587,994
 *     bytes of real PDF.
 *   - RFM95W: `hoperf.com` 404s the recorded path. Archive: 1,960,835 bytes.
 *
 * It is deliberately a FALLBACK, not a first choice: the vendor's live copy is
 * the current one, and the archive should carry only the traffic the vendor
 * refuses. It lives inside the fetch primitive rather than as a fourth ladder
 * rung on purpose — nRF52840 needs it TWICE in one resolve (the recorded HTML
 * page 403s, and so does the Product Specification link found on it), so any
 * design that archived only the first URL would still fail this part.
 *
 * Snapshots are fetched with Wayback's `id_` modifier, which returns the bytes
 * as originally archived rather than the HTML viewer wrapper. That matters for
 * more than PDFs: an unrewritten page keeps its ORIGINAL hrefs, so candidate
 * links resolve against the vendor's own base URL and step 2 works unchanged.
 *
 * What this module deliberately does NOT do: search the archive for a PDF
 * whose FILENAME names the part. That was tried and rejected on evidence
 * (2026-07-17): a CDX query for archived `infocenter.nordicsemi.com/pdf/*`
 * matching "nrf52840" returns 17 documents, and not one of them is the
 * datasheet — they are all `HSR_` solder-reflow and `MCR_` material-content
 * reports, compliance paperwork full of numbers (masses, ppm, temperatures)
 * that would extract cleanly and mean nothing. Grounding a part against a
 * material content report is exactly the confidently-cited-wrong-number
 * failure this codebase is built to prevent. So the archive is only ever asked
 * for the SPECIFIC URL this part's datasheet was recorded at — archiving a URL
 * does not change which document it identifies.
 *
 * Nor does it do a general web-search fallback. That was investigated
 * (2026-07-17, live) before writing any code:
 *
 *   - DuckDuckGo's keyless HTML endpoint (`html.duckduckgo.com/html/?q=...`)
 *     answers a first request with real result HTML (verified: a plain
 *     `fetch` with a UA header got 200 + parseable result links). A SECOND
 *     request minutes later got HTTP 202 with an anomaly-detection/"unusual
 *     traffic" block page. A resolver that fires per-part across a
 *     22,000-part library would hit that wall almost immediately and then
 *     silently return nothing (or worse, stale/cached junk) for every part
 *     after the first. That is not a fallback a person can rely on, so it is
 *     not implemented. Per the house rule, an uncited gap (skip step 3, say
 *     so) beats a fallback that quietly degrades into noise.
 *   - No-API-key alternatives that don't rate-limit a bare client the same
 *     way were not found in the time available. If one shows up later, it
 *     slots in as a third ladder rung between `resolveFromLinks` and
 *     "give up" without changing this module's public shape.
 *
 * Step 4 (2026-07-18) is that third rung: the vendor's OWN site search, tried
 * only once steps 1-3 have all failed. `resolveFromVendorSearch` derives the
 * vendor host from the recorded URL and probes a couple of the query-string
 * conventions real vendor sites commonly use for on-site search. Trying a URL
 * shape that doesn't exist on a given host is harmless — it 404s (or returns
 * an unrelated page) and `fetchOnce`/`findPdfCandidates` treat that exactly
 * like any other dead link: zero candidates, next pattern tried, eventually a
 * clean "found nothing" rather than a guess. This is the SAME confidence gate
 * as every other rung — `pickBestCandidate` + `MIN_CONFIDENT_SCORE` — so a
 * search page that happens to list ten unrelated parts refuses to pick any of
 * them, same as a vendor page would.
 *
 * A general public "datasheet aggregator" rung (the other half of what was
 * asked for here) was investigated live (2026-07-18) and deliberately NOT
 * added, because no candidate found was actually usable:
 *
 *   - alldatasheet.com: `robots.txt` permits crawling its search and detail
 *     pages. But its "download" page is a gateway
 *     (`/datasheet-pdf/download/<id>/<mfg>/<part>.html`) whose raw HTML source
 *     contains zero occurrences of a literal `.pdf` href anywhere — verified
 *     by searching the raw page source, not just the rendered UI. There is no
 *     link `findPdfCandidates` could ever score, so this rung would only ever
 *     return "no candidate": dead weight, not a fallback.
 *   - datasheets.com (Supplyframe/Octopart's site): `robots.txt` contains
 *     `User-agent: ClaudeBot` / `Disallow: /` — automated access by this
 *     agent is explicitly forbidden by name. Hard "no" per the governing rule
 *     that a source's terms are not ours to route around.
 *   - digikey.com: `robots.txt` explicitly *allows* ClaudeBot, but its
 *     product-search results page, fetched plain (no JS execution), contains
 *     zero occurrences of the word "Datasheet" anywhere in the raw HTML —
 *     the datasheet link is populated client-side after hydration, invisible
 *     to a bare `fetch`. Making it visible would mean running a JS engine
 *     (Puppeteer/Playwright), which is a much larger dependency and latency
 *     cost than this ladder rung is worth, and was out of scope for this
 *     change regardless.
 *
 * If a genuinely fetchable, ToS-clean, key-free aggregator shows up later, it
 * slots in as a rung between `resolveFromVendorSearch` and "give up" without
 * changing this module's public shape — same as the note above always said.
 *
 * HTML parsing here is a small regex over `<a href="...">text</a>`, not a
 * dependency. A vendor product page is simple enough that a real DOM parser
 * (cheerio, linkedom — both MIT, so license would not have blocked them)
 * buys nothing: we only need anchor href + inner text pairs, and a regex
 * that's wrong for some `<a>` shape just yields fewer candidates, never a
 * wrong one — every candidate is still fetched and its magic bytes checked
 * before anything is trusted. Adding a parser dependency for this would be
 * weight without a corresponding drop in risk.
 */

const PDF_MAGIC = "%PDF-";
const FETCH_TIMEOUT_MS = 30_000;
/** the archive replays large files from cold storage and is legitimately slower than a vendor CDN */
const ARCHIVE_TIMEOUT_MS = 90_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;
}

/** letters+digits only, lowercased — so "MDBT50Q-1MV2" matches "mdbt50q1mv2" wherever it appears */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface PdfLinkCandidate {
  url: string;
  /** the anchor's visible text, trimmed — kept so a human can audit the pick */
  text: string;
  score: number;
}

/**
 * A candidate must clear this to be trusted at all. It is the same number as
 * the "datasheet" / "product specification" keyword score below, i.e. a bare
 * `.pdf` link with neither the MPN nor a datasheet-ish word near it is NOT
 * enough — the governing rule of this codebase is that a wrong-part PDF is
 * worse than no PDF, so an unscored coin-flip candidate must be refused, not
 * guessed.
 */
const MIN_CONFIDENT_SCORE = 15;

const SCORE_MPN_MATCH = 100;
const SCORE_DATASHEET_WORD = 20;
const SCORE_SPEC_WORD = 15;
const SCORE_MANUAL_WORD = 5;

/**
 * A "Product Brief" is a marketing summary, not a datasheet, and it is the trap
 * on this exact page: Nordic's nRF52840 topic page links "nRF52840 Product Brief
 * v2.0" right beside "nRF52840 Product Specification v1.0". Both carry the MPN,
 * so on MPN score alone they tie at 100 and the winner is whichever the regex
 * happened to see first. The brief has real-looking numbers in it, so grounding
 * against one produces a part that extracts cleanly and is quietly wrong.
 *
 * Large enough to sink a brief BELOW MIN_CONFIDENT_SCORE even with a full MPN
 * match, so it is never picked — not merely ranked second. If a brief is the
 * only PDF a vendor offers, the honest answer is that we did not find the
 * datasheet, not that we found something adjacent to it.
 */
const SCORE_BRIEF_PENALTY = 120;

/**
 * Pure — no network. Scans `html` for `<a href>` tags, resolves each href
 * against `baseUrl`, keeps the ones that look like a PDF document, and scores
 * them by how strongly the href/link-text names this part.
 *
 * Exported so the ranking logic (the part that decides whether a fetch is
 * even worth trying) can be unit-tested without a network — see
 * `datasheet-resolver.test.ts`.
 */
export function findPdfCandidates(html: string, baseUrl: string, mpn: string): PdfLinkCandidate[] {
  const mpnKey = normalizeForMatch(mpn);
  const seen = new Map<string, PdfLinkCandidate>();

  // Deliberately loose: nested tags inside an <a> (e.g. <a><span>text</span></a>)
  // are captured whole and stripped of markup below. A malformed/unclosed tag
  // just fails to match and yields one fewer candidate — never a wrong one.
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const rawHref = match[1] ?? "";
    const rawText = match[2] ?? "";
    if (/^(javascript:|mailto:|tel:|#)/i.test(rawHref.trim())) continue;

    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue; // unresolvable href (e.g. malformed) — skip, don't guess
    }

    // Only documents that look like a PDF by path are candidates at all;
    // ranking below decides which one, but this filter keeps us from ever
    // fetching an unrelated stylesheet or nav link.
    if (!resolved.pathname.toLowerCase().endsWith(".pdf")) continue;

    const text = rawText
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const haystack = normalizeForMatch(`${text} ${rawHref}`);
    let score = 0;
    if (mpnKey.length > 0 && haystack.includes(mpnKey)) score += SCORE_MPN_MATCH;
    if (/datasheet/i.test(text) || /datasheet/i.test(rawHref)) score += SCORE_DATASHEET_WORD;
    if (/product\s*specification/i.test(text)) score += SCORE_SPEC_WORD;
    if (/manual/i.test(text)) score += SCORE_MANUAL_WORD;
    if (/\bbrief\b/i.test(text) || /_pb_|-pb-|productbrief/i.test(rawHref)) score -= SCORE_BRIEF_PENALTY;

    const url = resolved.toString();
    const existing = seen.get(url);
    if (!existing || existing.score < score) {
      seen.set(url, { url, text, score });
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/**
 * The best candidate, or `undefined` if none clears the confidence bar —
 * refuse rather than guess. Does not assume `candidates` is pre-sorted (it
 * always is, coming from `findPdfCandidates`, but a caller passing its own
 * list — as the unit tests do — should not get a wrong answer from that).
 */
export function pickBestCandidate(candidates: PdfLinkCandidate[]): PdfLinkCandidate | undefined {
  const best = candidates.reduce<PdfLinkCandidate | undefined>(
    (top, c) => (!top || c.score > top.score ? c : top),
    undefined,
  );
  if (!best || best.score < MIN_CONFIDENT_SCORE) return undefined;
  return best;
}

interface FetchOutcome {
  bytes: Buffer;
  /** set only when the response was a non-PDF 200 — the thing step 2 parses */
  html?: string;
}

/**
 * One HTTP GET with the same failure taxonomy `deepen.ts` already measured
 * against this library's real vendor hosts (dead DNS, 403, 404). Distinct
 * from a hard failure: a 200 whose bytes aren't `%PDF-` is not an error here,
 * it's the HTML `resolveFromLinks` needs — callers branch on `.html`.
 */
async function fetchOnce(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchOutcome> {
  const host = hostOf(url);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(`${host} did not respond — the link looks dead`);
  }
  if (res.status === 403) throw new Error(`${host} blocks automatic downloads`);
  if (res.status === 404) throw new Error(`${host} returned 404 for this address`);
  if (!res.ok) throw new Error(`${host} returned HTTP ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (isPdf(bytes)) return { bytes };
  return { bytes, html: bytes.toString("utf8") };
}

/**
 * Rewrite a Wayback snapshot URL into its `id_` form, which serves the bytes as
 * originally archived instead of the HTML viewer wrapper (toolbar injected,
 * links rewritten to point back into the archive).
 *
 * Pure and exported so the transform is testable without a network — getting it
 * wrong is silent: the availability API's URL fetches fine and returns a
 * *plausible* page, just wrapped, whose rewritten hrefs would then resolve
 * against web.archive.org instead of the vendor.
 */
export function rawSnapshotUrl(snapshotUrl: string): string {
  return snapshotUrl.replace(/\/web\/(\d{4,})(?:id_)?\//, "/web/$1id_/");
}

/** `20240314015350` → `2024-03-14`, for a reason string a human can weigh. */
export function snapshotDate(timestamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(timestamp);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : timestamp;
}

interface ArchivedCopy {
  outcome: FetchOutcome;
  /** ISO-ish date of the snapshot — part of WHY these bytes were trusted */
  date: string;
}

interface WaybackAvailability {
  archived_snapshots?: {
    closest?: { available?: boolean; url?: string; timestamp?: string; status?: string };
  };
}

/**
 * The same URL, as the Internet Archive last saw it. Returns undefined when the
 * archive has no usable snapshot — a normal outcome, not an error.
 *
 * Only a snapshot the archive recorded as HTTP 200 is used: it also stores the
 * 403 challenge pages and 404s, and replaying a captured error page as though
 * it were a datasheet is precisely the failure being fixed here.
 */
async function fetchFromArchive(url: string): Promise<ArchivedCopy | undefined> {
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  let closest: NonNullable<NonNullable<WaybackAvailability["archived_snapshots"]>["closest"]>;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as WaybackAvailability;
    const found = body.archived_snapshots?.closest;
    if (!found?.url || found.available !== true || found.status !== "200") return undefined;
    closest = found;
  } catch {
    return undefined; // archive down or slow — not this part's problem to report
  }

  try {
    const outcome = await fetchOnce(rawSnapshotUrl(closest.url as string), ARCHIVE_TIMEOUT_MS);
    return { outcome, date: snapshotDate(closest.timestamp ?? "") };
  } catch {
    return undefined;
  }
}

interface Retrieved extends FetchOutcome {
  /** how these bytes were obtained — carried into the audit reason */
  via: string;
}

/**
 * One URL, tried at the vendor first and at the archive only if the vendor
 * cannot supply it. The vendor's live copy is authoritative when it is real;
 * the archive covers 403s, 404s, hosts that no longer exist — and rot.
 *
 * `expectPdf` encodes the hard-won rule that **HTTP 200 is not success**. When
 * we are following a link that was scored as this part's datasheet, a 200 that
 * hands back HTML is not a page to parse, it is a failure wearing a success
 * code — Nordic answers exactly this for `nRF52840_PS_v1.0.pdf`, returning a
 * redirect stub rather than the file. Keying off the status code cannot catch
 * it (that same host answers 403 to PowerShell and 200 to Node's fetch), so the
 * test is what came back, not what it was labelled.
 *
 * The vendor's own error survives into the reason string, because "Nordic blocks
 * automatic downloads" is far more useful to a person than "no archived copy".
 */
async function retrieve(url: string, expectPdf = false): Promise<Retrieved> {
  let vendor: FetchOutcome | undefined;
  let softReason: string;
  try {
    vendor = await fetchOnce(url);
    // a page is a fine answer unless we were promised a document
    if (!(expectPdf && vendor.html)) return { ...vendor, via: "vendor" };
    softReason = `${hostOf(url)} served a web page where a PDF was expected`;
  } catch (err) {
    softReason = err instanceof Error ? err.message : String(err);
  }

  const archived = await fetchFromArchive(url);
  if (!archived || (expectPdf && archived.outcome.html)) {
    // Nothing better exists. Hand back the vendor's page if we got one so the
    // caller can report precisely what it was; otherwise the failure is total.
    if (vendor) return { ...vendor, via: "vendor" };
    throw new Error(`${softReason}, and the Internet Archive has no usable copy of it`);
  }
  return { ...archived.outcome, via: `the Internet Archive's ${archived.date} copy (${softReason})` };
}

export interface ResolvedDatasheet {
  bytes: Buffer;
  /** the URL bytes actually came from — may differ from the recorded URL when step 2 followed a link */
  url: string;
  /** human-auditable: why this URL was trusted (see governing-rule comment above) */
  reason: string;
}

/** shorter than FETCH_TIMEOUT_MS: these are speculative probes of URL shapes that may not exist at all */
const VENDOR_SEARCH_TIMEOUT_MS = 10_000;

/**
 * Pure — no network. The query-string conventions real vendor sites most
 * commonly use for their own on-site search. Deliberately a short, fixed
 * list (not an open-ended guess-anything scheme): each extra pattern is one
 * more sequential network round trip on the failure path, and "total added
 * latency must be bounded" is a hard constraint here. Exported so the URL
 * derivation can be checked without a network — see
 * `datasheet-resolver.test.ts`.
 */
export function vendorSearchUrls(host: string, mpn: string): string[] {
  const q = encodeURIComponent(mpn);
  return [`https://${host}/search?q=${q}`, `https://${host}/?s=${q}`];
}

/**
 * Rung 4: the vendor's own site search, tried only once the recorded URL —
 * live, archived, and crawled for links on both — has produced nothing
 * confident. Same shape as step 2's `resolveFromLinks`: fetch a page, score
 * its links with `findPdfCandidates`, follow the best one through `retrieve`
 * so a 200-with-HTML "success" still gets caught. Never throws — a probed URL
 * shape that doesn't exist on this host is a normal outcome (try the next
 * one), not an error; the caller decides what "nothing worked at all" means.
 */
async function resolveFromVendorSearch(recordedUrl: string, mpn: string): Promise<ResolvedDatasheet | undefined> {
  const host = hostOf(recordedUrl);
  for (const searchUrl of vendorSearchUrls(host, mpn)) {
    let outcome: FetchOutcome;
    try {
      outcome = await fetchOnce(searchUrl, VENDOR_SEARCH_TIMEOUT_MS);
    } catch {
      continue; // this convention doesn't exist on this host — try the next one
    }
    // A bare PDF answering a guessed *search* URL (not a specific part page)
    // is not evidence it names this MPN — refuse rather than guess, same as
    // everywhere else in this module.
    if (!outcome.html) continue;

    const best = pickBestCandidate(findPdfCandidates(outcome.html, searchUrl, mpn));
    if (!best) continue;

    let followed: Retrieved;
    try {
      followed = await retrieve(best.url, true);
    } catch {
      continue;
    }
    if (followed.html) continue;

    return {
      bytes: followed.bytes,
      url: best.url,
      reason: `${host} did not link ${mpn}'s datasheet from the recorded URL (or its archive); found it via ${host}'s own site search (${searchUrl}), which linked "${best.text}", fetched from ${followed.via}`,
    };
  }
  return undefined;
}

/**
 * The ladder: (1) recorded URL as-is, (2) if that's HTML, the best-scoring
 * PDF link found on it, (3) the Internet Archive's copy of either. Throws
 * with a precise, human-readable reason on total failure — `deepenComponent`
 * already treats that as a normal, catchable outcome (a part that cannot
 * ground is not a bug), so this does not need its own try/catch wrapper.
 */
async function resolveViaRecordedUrl(recordedUrl: string, mpn: string): Promise<ResolvedDatasheet> {
  const direct = await retrieve(recordedUrl);
  if (!direct.html) {
    return { bytes: direct.bytes, url: recordedUrl, reason: `recorded URL served a PDF from ${direct.via}` };
  }

  const host = hostOf(recordedUrl);
  // The base is the RECORDED url, never the snapshot's: `id_` bytes are
  // unrewritten, so a relative href on an archived page still means what it
  // meant on the vendor's site.
  let best = pickBestCandidate(findPdfCandidates(direct.html, recordedUrl, mpn));
  let pageVia = direct.via;

  // HTTP 200 IS NOT SUCCESS. A page that still answers but no longer carries the
  // link is a soft failure, and it needs the same fallback as a hard one — this
  // is exactly the nRF52840. Nordic's recorded infocenter URL answers 200 with a
  // JavaScript redirect stub to docs.nordicsemi.com that contains no PDF links
  // at all, so `retrieve` is satisfied and the archive never gets asked. (It
  // answers 403 to some clients and 200 to others — measured: PowerShell gets
  // 403 where Node's fetch gets 200 — so this cannot be keyed off the status
  // code either.) The archive's 2019 copy of that same page is the real topic
  // page, and it links "nRF52840 Product Specification v1.0" directly.
  if (!best && direct.via === "vendor") {
    const archived = await fetchFromArchive(recordedUrl);
    if (archived) {
      if (!archived.outcome.html) {
        // the URL used to BE a PDF and has since rotted into a web page
        return {
          bytes: archived.outcome.bytes,
          url: recordedUrl,
          reason: `${host} now serves a web page; used the Internet Archive's ${archived.date} copy, which is the PDF`,
        };
      }
      const fromArchive = pickBestCandidate(findPdfCandidates(archived.outcome.html, recordedUrl, mpn));
      if (fromArchive) {
        best = fromArchive;
        pageVia = `the Internet Archive's ${archived.date} copy`;
      }
    }
  }

  if (!best) {
    throw new Error(
      `${host} returned a web page instead of a PDF, and no link on it — or on the Internet Archive's copy of it — clearly names ${mpn}'s datasheet`,
    );
  }

  let followed: Retrieved;
  try {
    followed = await retrieve(best.url, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${host} returned a web page instead of a PDF; the best-matching link "${best.text}" (${best.url}) failed too: ${message}`,
    );
  }
  if (followed.html) {
    throw new Error(
      `${host} returned a web page instead of a PDF; the best-matching link "${best.text}" (${best.url}) was also not a PDF`,
    );
  }
  return {
    bytes: followed.bytes,
    url: best.url,
    reason: `${host} served a web page (read from ${pageVia}); followed its best-matching link "${best.text}", fetched from ${
      followed.via
    } (score-ranked, matched ${
      normalizeForMatch(`${best.text} ${best.url}`).includes(normalizeForMatch(mpn)) ? "MPN" : "datasheet keyword"
    })`,
  };
}

/**
 * Public entry point. Tries the recorded-URL ladder (steps 1-3 above) in
 * full, and only when that has exhausted itself — recorded URL dead, its
 * archived copy dead too, and neither carried a confidently-scored link —
 * falls through to rung 4, the vendor's own site search. `resolveViaRecordedUrl`
 * throwing is a normal outcome here (a part that cannot ground is not a bug),
 * not something that needs its own try/catch upstream; this function's throw
 * on total failure carries the original reason forward so a human auditing a
 * failed part still sees exactly what the vendor and archive said, not just
 * that the site-search rung also came up empty.
 */
export async function resolveDatasheetPdf(recordedUrl: string, mpn: string): Promise<ResolvedDatasheet> {
  try {
    return await resolveViaRecordedUrl(recordedUrl, mpn);
  } catch (err) {
    const primaryMessage = err instanceof Error ? err.message : String(err);
    const viaVendorSearch = await resolveFromVendorSearch(recordedUrl, mpn);
    if (viaVendorSearch) return viaVendorSearch;
    throw new Error(`${primaryMessage}; ${hostOf(recordedUrl)}'s own site search for ${mpn} also found nothing confident`);
  }
}
