## Available Databases

- `aoc`: award-of-contract data, backed by `aoc_tenders.db`
- `tenders`: active and archived tender notice data, backed by `tenders_vps.db`

Always reference tables with their attached database alias, for example
`aoc.aoc_tenders` or `tenders.tenders`.

## `aoc` Database

Award notifications and award detail pages.

```sql
CREATE TABLE aoc.aoc_tenders (
  internal_id TEXT PRIMARY KEY,
  portal_type TEXT,
  year INTEGER,
  sl_no TEXT,
  aoc_date TEXT,
  closing_date TEXT,
  title TEXT,
  ref_no TEXT,
  tender_id TEXT,
  org_name TEXT,
  detail_url TEXT,
  partition_id INTEGER
);

CREATE TABLE aoc.aoc_details (
  internal_id TEXT PRIMARY KEY,
  tender_id TEXT,
  scraped_at TEXT,
  details_json TEXT
);
```

`aoc.aoc_details.details_json` is JSON text. Useful keys include:

- `Tender Type`
- `Contract Date`
- `Contract Value`
- `Published Date`
- `Tender Document`
- `Tender Ref. No.`
- `Organisation Name`
- `Tender Description`
- `Number of bids received`
- `Name of the selected bidder(s)`
- `Address of the selected bidder(s)`
- `Date of Completion/Completion Period in Days`

Join award listings to award details with:

```sql
aoc.aoc_tenders.internal_id = aoc.aoc_details.internal_id
```

## `tenders` Database

Published tender notice listings and parsed detail pages.

```sql
CREATE TABLE tenders.tenders (
  internal_id TEXT PRIMARY KEY,
  tender_id TEXT,
  detail_url TEXT,
  status TEXT,
  organisation_name TEXT,
  title TEXT,
  reference_number TEXT,
  portal_type TEXT,
  serial_number TEXT,
  e_published_date TEXT,
  bid_submission_closing_date TEXT,
  tender_opening_date TEXT,
  corrigendum_url TEXT,
  scraped_at TEXT,
  partition_id INTEGER
);

CREATE TABLE tenders.tender_details (
  internal_id TEXT PRIMARY KEY,
  tender_id TEXT,
  details_json TEXT,
  scraped_at TEXT
);
```

`tenders.tender_details.details_json` is JSON text. Useful keys include:

- `Tender Reference Number`
- `Tender Title`
- `Organisation Name`
- `Organisation Type`
- `Tender Category`
- `Tender Type`
- `Product Category`
- `Product Sub-Category`
- `ePublished Date`
- `Bid Opening Date`
- `Bid Submission Start Date`
- `Bid Submission End Date`
- `Document Download Start Date`
- `Document Download End Date`
- `EMD`
- `Tender Fee`
- `Location`
- `Address`
- `Name`
- `Work Description`
- `Tender Document`

Join tender listings to tender details with:

```sql
tenders.tenders.internal_id = tenders.tender_details.internal_id
```

## Query Guidance

- Use `json_extract(details_json, '$."Key Name"')` for JSON fields with spaces.
- Use `date(...)` or `strftime(...)` cautiously because source date strings may vary.
- For broad listing questions, include `LIMIT`.
- For count or ranking questions, group by the relevant organisation, bidder, year, or
  category field and order by the aggregate descending.
