import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import OpenAI from 'openai';
import YAML from 'yaml';

const DEFAULT_CONFIG_PATH = 'config.yaml';
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let nextRequestId = 1;

async function main() {
  const configPath = resolveConfigPath();
  const config = loadConfig(configPath);
  const contextText = fs.readFileSync(config.context.path, 'utf8');
  logInfo('config-loaded', {
    configPath,
    contextPath: config.context.path,
    databases: config.databases.map((db) => ({ alias: db.alias, path: db.path })),
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      temperature: config.llm.temperature,
    },
    query: config.query,
  });

  const client = new OpenAI({
    baseURL: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get(['/', '/index.html'], (req, res, next) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      databases: config.databases.map((db) => db.alias),
    });
  });

  app.get('/databases', (req, res) => {
    res.json({
      databases: config.databases.map((db) => ({ alias: db.alias })),
    });
  });

  app.post('/query', async (req, res) => {
    const requestId = nextRequestId;
    nextRequestId += 1;

    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    logInfo('query-request', {
      requestId,
      remoteAddress: req.ip,
      question,
    });

    if (!question) {
      logWarn('query-rejected', {
        requestId,
        reason: 'missing-question',
      });
      res.status(400).json({ ok: false, error: 'Request body must include a non-empty "question" string.' });
      return;
    }

    try {
      const { sql, rows } = await answerWithSqlRows({ requestId, question, config, contextText, client });
      logInfo('query-response', {
        requestId,
        rowCount: rows.length,
      });
      res.json({ ok: true, sql, rows });
    } catch (err) {
      const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
      logError('query-failed', {
        requestId,
        status,
        error: formatError(err),
      });
      res.status(status).json({
        ok: false,
        error: err.message,
      });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found.' });
  });

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      logWarn('request-invalid-json', {
        error: formatError(err),
      });
      res.status(400).json({ ok: false, error: 'Invalid JSON request body.' });
      return;
    }
    logError('request-unexpected-error', {
      error: formatError(err),
    });
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  });

  app.listen(config.server.port, config.server.host, () => {
    console.log(`sqlite-llm listening on http://${config.server.host}:${config.server.port}`);
  });
}

async function answerWithSqlRows({ requestId, question, config, contextText, client }) {
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({ config, contextText, databases: config.databases }),
    },
    {
      role: 'user',
      content: `Question:\n${question}`,
    },
  ];

  let lastError = null;

  for (let attempt = 1; attempt <= config.query.maxAttempts; attempt += 1) {
    logInfo('llm-attempt-start', {
      requestId,
      attempt,
      maxAttempts: config.query.maxAttempts,
    });

    const content = await callLlmForSql({ requestId, attempt, client, config, messages });
    let sql;

    try {
      sql = extractSqlFromFence(content);
      logInfo('llm-sql-extracted', {
        requestId,
        attempt,
        sql,
      });

      const rows = executeReadOnlyQuery(sql, config, { requestId, attempt });
      logInfo('sql-query-succeeded', {
        requestId,
        attempt,
        rowCount: rows.length,
      });
      return { sql, rows };
    } catch (err) {
      lastError = err;
      logError('sql-attempt-failed', {
        requestId,
        attempt,
        sql: sql || null,
        error: formatError(err),
      });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: [
          `The SQL attempt failed on attempt ${attempt} of ${config.query.maxAttempts}.`,
          'Return a corrected single SQLite read-only query in exactly one ```sql fenced block.',
          '',
          'Error:',
          String(err.message),
          '',
          sql ? `Failed SQL:\n\`\`\`sql\n${sql}\n\`\`\`` : 'No valid SQL was extracted from the previous response.',
        ].join('\n'),
      });
    }
  }

  const error = new Error(`Unable to produce a working SQL query after ${config.query.maxAttempts} attempts: ${lastError?.message || 'unknown error'}`);
  error.statusCode = 422;
  throw error;
}

async function callLlmForSql({ requestId, attempt, client, config, messages }) {
  let response;
  try {
    response = await client.chat.completions.create({
      model: config.llm.model,
      messages,
      temperature: config.llm.temperature,
    });
  } catch (err) {
    logError('llm-request-failed', {
      requestId,
      attempt,
      model: config.llm.model,
      error: formatError(err),
    });
    throw err;
  }

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const error = new Error('LLM returned an empty response.');
    logError('llm-response-empty', {
      requestId,
      attempt,
      model: config.llm.model,
      finishReason: response.choices?.[0]?.finish_reason,
      error: formatError(error),
    });
    throw error;
  }
  logInfo('llm-response', {
    requestId,
    attempt,
    model: config.llm.model,
    finishReason: response.choices?.[0]?.finish_reason,
    content,
  });
  return content;
}

function buildSystemPrompt({ config, contextText, databases }) {
  const aliases = databases.map((db) => `- ${db.alias}`).join('\n');
  return [
    'You convert user questions into exactly one SQLite query.',
    '',
    'Rules:',
    '- Return exactly one SQL query inside one markdown fenced block tagged `sql`.',
    '- Do not include prose outside the fenced block.',
    '- Only generate read-only SELECT or WITH queries.',
    '- Use attached database aliases when referencing tables, for example alias.table_name.',
    '- Prefer explicit limits for broad listing questions.',
    '- Do not use INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH, DETACH, PRAGMA, VACUUM, or other mutating/administrative statements.',
    `- We are restricting sending the queries rows back to the user to only ${config.query.maxRows} rows, so, its better to use limit appropriately in your query. Make sure the limit is applied on final output, not the inner query, if any.`,
    '',
    'Attached database aliases:',
    aliases,
    '',
    'Raw database context:',
    contextText,
  ].join('\n');
}

function extractSqlFromFence(content) {
  const sqlFence = content.match(/```sql\s*([\s\S]*?)```/i);
  const anyFence = content.match(/```\s*([\s\S]*?)```/);
  const sql = (sqlFence?.[1] ?? anyFence?.[1] ?? '').trim();
  if (!sql) {
    throw new Error('LLM response did not contain a markdown SQL fence.');
  }
  return normalizeSql(sql);
}

function normalizeSql(sql) {
  const withoutTrailingSemicolons = sql.trim().replace(/;+$/g, '').trim();
  if (!withoutTrailingSemicolons) {
    throw new Error('SQL query is empty.');
  }
  if (withoutTrailingSemicolons.includes(';')) {
    throw new Error('Only one SQL statement is allowed.');
  }
  if (!/^(select|with)\b/i.test(withoutTrailingSemicolons)) {
    throw new Error('Only read-only SELECT or WITH queries are allowed.');
  }
  return withoutTrailingSemicolons;
}

function executeReadOnlyQuery(sql, config, logContext = {}) {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = OFF');
    attachConfiguredDatabases(db, config.databases);
    db.pragma('query_only = ON');

    logInfo('sql-query-start', {
      ...logContext,
      sql,
    });

    const statement = db.prepare(sql);
    if (!statement.reader) {
      throw new Error('Only row-returning read-only queries are allowed.');
    }

    const rows = [];
    for (const row of statement.iterate()) {
      rows.push(row);
      if (rows.length >= config.query.maxRows) break;
    }
    return rows;
  } finally {
    db.close();
    logInfo('sql-connection-closed', logContext);
  }
}

function attachConfiguredDatabases(db, databases) {
  for (const item of databases) {
    db.exec(`ATTACH DATABASE ${sqlString(item.path)} AS ${quoteIdentifier(item.alias)}`);
  }
}

function loadConfig(configPath) {
  const configDir = path.dirname(configPath);
  const raw = interpolateEnv(fs.readFileSync(configPath, 'utf8'));
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('config.yaml must contain an object.');
  }

  const config = {
    server: {
      host: parsed.server?.host ?? '127.0.0.1',
      port: parsed.server?.port ?? 3100,
    },
    llm: {
      baseUrl: parsed.llm?.baseUrl,
      apiKey: parsed.llm?.apiKey,
      model: parsed.llm?.model,
      temperature: parsed.llm?.temperature ?? 0,
    },
    query: {
      maxAttempts: parsed.query?.maxAttempts ?? 4,
      maxRows: parsed.query?.maxRows ?? 1000,
    },
    context: {
      path: resolveFrom(configDir, parsed.context?.path),
    },
    databases: Array.isArray(parsed.databases)
      ? parsed.databases.map((item) => ({
          alias: item?.alias,
          path: resolveFrom(configDir, item?.path),
        }))
      : [],
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!Number.isInteger(config.server.port) || config.server.port <= 0) {
    throw new Error('server.port must be a positive integer.');
  }
  requireString(config.llm.baseUrl, 'llm.baseUrl');
  requireString(config.llm.apiKey, 'llm.apiKey');
  requireString(config.llm.model, 'llm.model');
  if (!Number.isFinite(Number(config.llm.temperature))) {
    throw new Error('llm.temperature must be a number.');
  }
  config.llm.temperature = Number(config.llm.temperature);

  if (!Number.isInteger(config.query.maxAttempts) || config.query.maxAttempts <= 0) {
    throw new Error('query.maxAttempts must be a positive integer.');
  }
  if (!Number.isInteger(config.query.maxRows) || config.query.maxRows <= 0) {
    throw new Error('query.maxRows must be a positive integer.');
  }

  requireString(config.context.path, 'context.path');
  assertReadableFile(config.context.path, 'context.path');

  if (config.databases.length === 0) {
    throw new Error('databases must contain at least one database entry.');
  }

  const seenAliases = new Set();
  for (const item of config.databases) {
    requireString(item.alias, 'databases[].alias');
    if (!ALIAS_RE.test(item.alias)) {
      throw new Error(`Invalid database alias "${item.alias}". Use letters, numbers, and underscores, starting with a letter or underscore.`);
    }
    if (seenAliases.has(item.alias)) {
      throw new Error(`Duplicate database alias "${item.alias}".`);
    }
    seenAliases.add(item.alias);

    requireString(item.path, `databases[${item.alias}].path`);
    assertReadableFile(item.path, `databases[${item.alias}].path`);
  }
}

function resolveConfigPath() {
  const configArgIndex = process.argv.findIndex((arg) => arg === '--config');
  const explicitPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : null;
  const configPath = explicitPath || process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH;
  return path.resolve(process.cwd(), configPath);
}

function resolveFrom(baseDir, value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function interpolateEnv(text) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? '');
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertReadableFile(filePath, label) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`${label} must point to a readable file: ${filePath}`);
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function logInfo(event, details = {}) {
  console.log(formatLog('info', event, details));
}

function logWarn(event, details = {}) {
  console.warn(formatLog('warn', event, details));
}

function logError(event, details = {}) {
  console.error(formatLog('error', event, details));
}

function formatLog(level, event, details) {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...details,
  });
}

function formatError(err) {
  return {
    name: err?.name,
    message: err?.message || String(err),
    stack: err?.stack,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    logError('startup-failed', {
      error: formatError(err),
    });
    process.exit(1);
  });
}
