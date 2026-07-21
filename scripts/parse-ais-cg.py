#!/usr/bin/env python3
"""Parse the AIS "Sale of securities and units of mutual fund" (SFT-17) table
into statement-data.json capital-gains rows.

Why this exists: for clients with an active equity book the AIS carries this
table as hundreds of multi-line rows across many pages. Parsing it by hand (or
by an agent iterating regexes in-session) is slow and error-prone; this script
does it deterministically and loudly reports anything it could not parse.

Usage:
    pdftotext -layout -upw <password> AIS.pdf /tmp/<client>_ais_layout.txt
    python3 scripts/parse-ais-cg.py /tmp/<client>_ais_layout.txt \
        [--per-lot] [--expect-sale-total N] [--out file.json]
    (or: bun run parse-cg <ais_layout.txt>)

Output: one JSON object on stdout (or --out):
    {
      "shortTerm": [...], "longTerm": [...],   # statement-data capitalGains shape
      "totals": {"saleValue": ..., "cost": ..., "shortTermGain": ..., "longTermGain": ...},
      "lots": N, "unparsed": [...]
    }
By default lots are grouped per (ISIN-or-name, term): saleValue/cost summed,
saleDate = latest lot. --per-lot emits every AIS row instead.

Row semantics (verified against a 241-row and a 549-row real AIS): one lot is a
DATA LINE plus zero or more FRAGMENT lines. The data line always carries
    "<sr> <sale date DD/MM/YYYY> <middle text> <qty> <price/unit> <sale value>
     <cost> <n> <n> <n> <Active|Inactive>"
(seven numeric columns before the status). The middle text holds the security
name followed by the class / debit-type / credit-type / term column values -
but pdftotext wraps those column values differently per file:
  - single-line: "...NAME Listed Equity Market Off Short" (241-row file)
  - marker-above: a keyword-only line ("Listed   Off   Short") ABOVE the data
    line, with the leftovers stranded in the middle text ("...NAME Equity Share
    Market market term") - 549-row file, majority variant
  - name-above: a long security name (+ class start) wraps ABOVE the data line,
    leaving the middle text with keywords only - 549-row file, minority variant
  - name-below: an ISIN/name continuation line AFTER the data line (241-row file)
Assembly therefore anchors on data lines and attaches fragments by content:
keyword-only fragments attach forward (marker-above); name-bearing fragments
attach forward only when the next data line has no name of its own (name-above),
otherwise backward (name-below). Term/class/off-market are read ONLY from the
column-zone keywords (trailing keyword runs + marker fragments), never from the
name text, so a security named "LONG TERM EQUITY FUND" cannot flip a lot's term.

Self-verification (fix the input or extend the script, never ignore):
  - any table-looking line that fails the data-line regex is reported and exits 1
  - a lot whose term or name cannot be established is reported and exits 1
  - serial numbers must be contiguous 1..N (a gap means a row was lost)
  - --expect-sale-total (the TIS "Sale of securities" total) must match the sum
  - cost of 0 (off-market transfer-in without a depository cost basis) sets
    costUnconfirmed: true - the statement builder turns that into a loud flag;
    NEVER file a zero cost as-is (AGENTS.md gotcha)
  - asset classes other than listed equity / equity-oriented MF are emitted with
    an assetClass the statement builder refuses, forcing a conscious decision
"""

import argparse
import json
import re
import sys

# the numeric tail: 7 number columns then the status - the data-line anchor
DATA_LINE = re.compile(
    r"^\s*(?P<sr>\d+)\s+(?P<date>\d{2}/\d{2}/\d{4})"
    r"(?:\s+(?P<middle>.*?))?"
    r"\s+(?P<tail>(?:[\d,]+(?:\.\d+)?\s+){7})(?P<status>Active|Inactive)\s*$"
)
# weaker shape used only to report near-misses loudly
TABLE_LOOKING = re.compile(r"^\s*\d+\s+\d{2}/\d{2}/\d{4}\s")
ISIN = re.compile(r"\(([A-Z]{2}[A-Z0-9]{9}\d)\)")
# page furniture / repeated headers - generic across AIS downloads
NOISE = re.compile(
    r"Download ID|IP Address|Generation Date|Page \d+ of \d+|"
    r"^\s*PAN\s+Name\s+Financial Year|^\s*[A-Z]{5}\d{4}[A-Z]\s+[A-Z]|"
    r"^\s*SR\.?\s*(NO\.?)?\s*DATE OF SALE|^\s*NO\.\s*TRANSFER|^\s*VALUE\s*$|"
    r"^\s*/TRANSFER\b|CONSIDERATION\s+ACQUISITION|SHORT/LONG\s+TERM"
)


def has_real_name(text):
    """A security name, as opposed to ISIN parens / '10/-' FV remnants / keywords."""
    return bool(re.search(r"[A-Za-z]{3}", text))
# column-zone vocabulary: class + debit/credit type + term words, as AIS prints them
KEYWORDS = {
    "listed", "unlisted", "equity", "share", "shares", "unit", "units", "mutual",
    "fund", "oriented", "debenture", "debentures", "bond", "bonds", "others",
    "market", "off", "short", "long", "term",
}


def num(x):
    v = float(str(x).replace(",", ""))
    return int(v) if v == int(v) else v


def tokens(text):
    return [t for t in re.split(r"\s+", text.strip()) if t]


def is_keyword(tok):
    return tok.lower() in KEYWORDS


def split_trailing_keywords(text):
    """Split 'NAME WORDS... keyword keyword...' -> (name part, column-zone tokens)."""
    toks = tokens(text)
    i = len(toks)
    while i > 0 and is_keyword(toks[i - 1]):
        i -= 1
    return " ".join(toks[:i]), toks[i:]


def classify(column_tokens):
    """Asset class from the column-zone keywords ('equity' is the modelled class)."""
    low = {t.lower() for t in column_tokens}
    if low & {"debenture", "debentures"}:
        return "debenture"
    if low & {"bond", "bonds"}:
        return "bond"
    if "unlisted" in low:
        return "unlisted-equity"
    if "equity" in low:
        return "equity"
    if "fund" in low or "mutual" in low:
        return "mutual-fund (confirm equity-oriented before treating as 111A/112A)"
    return "unknown"


class Lot:
    def __init__(self, m):
        self.sr = int(m["sr"])
        self.saleDate = m["date"]
        mid = m["middle"] or ""
        im = ISIN.search(mid)
        self.isin = im.group(1) if im else None
        name, cols = split_trailing_keywords(ISIN.sub("", mid))
        self.name_parts = [name] if name else []
        self.pre_name_parts = []  # name fragments wrapped above the data line
        self.column_tokens = list(cols)
        nums = tokens(m["tail"])
        self.qty, self.price, self.saleValue, self.cost = (num(n) for n in nums[:4])
        self.status = m["status"]

    def has_name(self):
        # "(INE343H01029)" or a stranded "10/-" FV remnant is NOT a name - a lot
        # whose middle has no real name expects its name/marker line wrapped above.
        return has_real_name(" ".join(self.pre_name_parts + self.name_parts))

    def add_fragment(self, text, forward):
        im = ISIN.search(text)
        if im and not self.isin:
            self.isin = im.group(1)
        name, cols = split_trailing_keywords(ISIN.sub("", text))
        self.column_tokens += cols
        if name:
            (self.pre_name_parts if forward else self.name_parts).append(name)

    def finish(self):
        self.name = " ".join(self.pre_name_parts + self.name_parts).strip()
        low = {t.lower() for t in self.column_tokens}
        self.term = "Short" if "short" in low else ("Long" if "long" in low else None)
        self.assetClass = classify(self.column_tokens)
        self.offMarket = "off" in low
        return self


def parse(lines):
    lots, failed, pending = [], [], []

    # Scope to the table: only lines near data lines participate. The rest of the
    # AIS (other sections, prose) must not be swept up as fragments.
    data_idx = [i for i, raw in enumerate(lines)
                if DATA_LINE.match(re.sub(r"\s+", " ", raw.strip()))]
    if not data_idx:
        return [], ["no data lines found - is this really pdftotext -layout output of an AIS?"]
    lines = lines[max(0, data_idx[0] - 3):data_idx[-1] + 3]

    def attach_pending(next_lot):
        """Distribute fragments buffered since the previous data line."""
        for text in pending:
            name_part, _ = split_trailing_keywords(ISIN.sub("", text))
            keyword_only = not has_real_name(name_part)
            # ISIN continuations belong to the lot they follow (name-below shape),
            # even when the NEXT data line happens to be name-less.
            isin_continuation = ISIN.search(text) and lots and lots[-1].isin is None
            if next_lot is not None and not isin_continuation and (
                keyword_only or not next_lot.has_name()
            ):
                next_lot.add_fragment(text, forward=True)
            elif lots:
                lots[-1].add_fragment(text, forward=False)
            else:
                failed.append(f"orphan fragment: {text}")
        pending.clear()

    for raw in lines:
        line = re.sub(r"\s+", " ", raw.strip())
        if not line or NOISE.search(raw):
            continue
        m = DATA_LINE.match(line)
        if m:
            lot = Lot(m)
            attach_pending(lot)
            lots.append(lot)
        elif TABLE_LOOKING.match(line):
            failed.append(line)  # data-shaped but the tail/status didn't parse
        else:
            pending.append(line)
    attach_pending(None)

    complete = []
    for lot in lots:
        lot.finish()
        if not lot.term:
            failed.append(f"sr {lot.sr}: could not establish Short/Long term "
                          f"(column tokens: {lot.column_tokens})")
        elif not lot.name:
            failed.append(f"sr {lot.sr}: no security name assembled")
        else:
            complete.append(lot)
    return complete, failed


def to_item(name, isin, asset_class, sale_date, sale, cost, unconfirmed, off_market):
    item = {"name": name, "saleDate": sale_date, "saleValue": sale, "cost": cost,
            "source": "AIS SFT (sale of securities)"}
    if isin:
        item["isin"] = isin
    if asset_class != "equity":
        item["assetClass"] = asset_class  # builder refuses non-equity: decide consciously
    if unconfirmed:
        item["costUnconfirmed"] = True  # zero/absent depository cost - get the real cost
    if off_market:
        item["offMarket"] = True
    return item


def date_key(d):
    dd, mm, yyyy = d.split("/")
    return (int(yyyy), int(mm), int(dd))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("layout_txt", help="output of: pdftotext -layout -upw <pw> AIS.pdf out.txt")
    ap.add_argument("--per-lot", action="store_true", help="one item per AIS row (default: grouped)")
    ap.add_argument("--expect-sale-total", type=float, default=None,
                    help="TIS 'Sale of securities' total; mismatch exits 1")
    ap.add_argument("--out", help="write JSON here instead of stdout")
    args = ap.parse_args()

    with open(args.layout_txt, encoding="utf-8", errors="replace") as f:
        lots, failed = parse(f.readlines())

    problems = []
    if failed:
        problems.append(f"{len(failed)} line(s)/lot(s) failed to parse:")
        problems += [f"  FAIL: {l}" for l in failed[:20]]
    srs = sorted(l.sr for l in lots)
    if srs:
        missing = sorted(set(range(1, max(srs) + 1)) - set(srs))
        if missing:
            problems.append(f"serial-number gaps (rows lost?): {missing[:30]}"
                            + (" ..." if len(missing) > 30 else ""))
        dupes = sorted({s for s in srs if srs.count(s) > 1})
        if dupes:
            problems.append(f"duplicate serial numbers (over-matched?): {dupes[:30]}")

    if args.per_lot:
        items = {"Short": [], "Long": []}
        for l in sorted(lots, key=lambda l: date_key(l.saleDate)):
            items[l.term].append(to_item(l.name, l.isin, l.assetClass, l.saleDate,
                                         l.saleValue, l.cost, l.cost == 0, l.offMarket))
    else:
        groups = {}
        for l in lots:
            groups.setdefault((l.isin or l.name, l.term), []).append(l)
        items = {"Short": [], "Long": []}
        for (key, term), ls in sorted(
            groups.items(),
            key=lambda kv: date_key(max((l.saleDate for l in kv[1]), key=date_key)),
        ):
            classes = {l.assetClass for l in ls}
            items[term].append(to_item(
                max(ls, key=lambda l: len(l.name)).name,
                ls[0].isin,
                classes.pop() if len(classes) == 1 else "mixed",
                max((l.saleDate for l in ls), key=date_key),
                sum(l.saleValue for l in ls),
                sum(l.cost for l in ls),
                any(l.cost == 0 for l in ls),
                any(l.offMarket for l in ls),
            ))

    sale_total = sum(l.saleValue for l in lots)
    result = {
        "shortTerm": items["Short"],
        "longTerm": items["Long"],
        "totals": {
            "saleValue": sale_total,
            "cost": sum(l.cost for l in lots),
            "shortTermGain": sum(l.saleValue - l.cost for l in lots if l.term == "Short"),
            "longTermGain": sum(l.saleValue - l.cost for l in lots if l.term == "Long"),
        },
        "lots": len(lots),
        "unparsed": failed,
    }

    if args.expect_sale_total is not None and abs(sale_total - args.expect_sale_total) > 0.5:
        problems.append(f"sale total {sale_total} does not match --expect-sale-total "
                        f"{args.expect_sale_total} (diff {sale_total - args.expect_sale_total})")

    out = json.dumps(result, indent=2)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out + "\n")
        print(f"saved: {args.out} ({len(lots)} lots -> "
              f"{len(items['Short'])} ST + {len(items['Long'])} LT items)", file=sys.stderr)
    else:
        print(out)

    zero_cost = sum(1 for l in lots if l.cost == 0)
    nonequity = sum(1 for l in lots if l.assetClass != "equity")
    if zero_cost:
        print(f"NOTE: {zero_cost} lot(s) with cost 0 -> costUnconfirmed (get the real cost "
              "from the client/broker before filing)", file=sys.stderr)
    if nonequity:
        print(f"NOTE: {nonequity} lot(s) not classed as listed equity -> assetClass set; "
              "the statement builder will refuse them until resolved", file=sys.stderr)
    if problems:
        print("ERROR: " + "\n".join(problems), file=sys.stderr)
        print("\nDo NOT retry this parse unchanged, and never hand-read the table to 'fill in' "
              "what failed - that is exactly the token-burning loop this parser exists to prevent. "
              "Instead: (a) if an AIS JSON export is available from the portal, fetch it (preferred "
              "source, no layout damage); (b) otherwise log the unparsed rows in "
              "docs/missing-functionality.md, park the client, and move on.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
