# sqlite-llm

Small unauthenticated HTTP API for querying one or more SQLite databases with natural
language.

The service sends the user question plus a raw markdown schema/context file to an
OpenAI-compatible chat model. The model must return one SQLite query inside a
markdown `sql` fence. The service extracts that query, attaches all configured
databases by alias, executes the query, and returns the executed SQL query together
with the resulting rows as JSON.

If SQL execution fails, the error is fed back to the model and it can try again up to
`query.maxAttempts`.

## Install

```bash
cd sqlite-llm
npm install
cp config.example.yaml config.yaml
```

Edit `config.yaml`, then start:

```bash
npm start
```

Use a custom config path:

```bash
node src/server.js --config /path/to/config.yaml
```

## Config

```yaml
server:
  host: 127.0.0.1
  port: 3100

llm:
  baseUrl: ${OPENAI_BASE_URL}
  apiKey: ${OPENAI_API_KEY}
  model: ${OPENAI_MODEL}
  temperature: 0

query:
  maxAttempts: 4
  maxRows: 1000

context:
  path: ./schema-context.md

databases:
  - alias: aoc
    path: ./data/aoc_tenders.db
  - alias: tenders
    path: ./data/tenders_vps.db
```

Each database is attached with:

```sql
ATTACH DATABASE '{path}' AS "{alias}"
```

Aliases must start with a letter or underscore and contain only letters, numbers, and
underscores. In the context markdown, describe tables using these aliases, for example
`tenders.tenders` or `aoc.aoc_tenders`.

## API

### `GET /health`

Returns service status and configured database aliases.

```json
{
  "ok": true,
  "databases": ["aoc", "tenders"]
}
```

### `GET /databases`

Returns public database aliases.

```json
{
  "databases": [{ "alias": "aoc" }, { "alias": "tenders" }]
}
```

### `POST /query`

Request:

```json
{
  "question": "Which organisations published the most tenders in 2024?"
}
```

Success response includes the executed SQL query and the result rows:

```json
{
  "ok": true,
  "sql": "SELECT organisation_name, COUNT(*) AS tender_count FROM tenders.tenders GROUP BY organisation_name ORDER BY tender_count DESC LIMIT 10",
  "rows": [
    {
      "organisation_name": "Example Department",
      "tender_count": 123
    }
  ]
}
```

Error response:

```json
{
  "ok": false,
  "error": "Unable to produce a working SQL query after 4 attempts: ..."
}
```

Example:

```bash
curl -s http://127.0.0.1:3100/query \
  -H 'content-type: application/json' \
  -d '{"question":"Show the top 10 organisations by tender count"}'
```

## Safety

This project has no auth by design. Treat it as public.

The server still applies basic protections:

- Only `SELECT` and `WITH` queries are accepted.
- Multiple SQL statements are rejected.
- SQLite is switched to `query_only` after configured databases are attached.
- Result output is capped by `query.maxRows`.
- Database file paths are not exposed by the public API.

This does not make arbitrary public querying cheap. Large analytical queries can still
consume CPU and disk I/O, so run it behind infrastructure that can enforce request
rate limits and process-level resource limits.
