// free-model-aggregator-02: one server, two client wires, and a real free model behind every answer.
//
// Built from the kit's starter (main.ts + lib/providers.ts + lib/wire.ts) with the routing, failover
// and cooldowns the starter left as TODOs implemented here:
//
//   - quality (60%): candidates are ranked by the brief's rating_milli, best first, per prompt
//     requirements — JSON prompts go to the best json-capable model (nemotron-3.5-super-vl, 1303),
//     every other prompt to the best model overall (inkling-2-small, 1475).
//   - failover (10%): a refused gateway call falls over to the next best eligible model, and every
//     refusal is reported on the response in x-makefun-upstream-failures (at most 8 rows).
//   - rate limits: a model that refuses cools down for the next two requests, so one rate-limited
//     model never takes every later prompt down with it; a model that answers clears its cooldown.
//     A 400/401/403 refusal is permanent for the trial (undiallable, not allowed, or gated to
//     agentic harnesses) and excludes the model outright — retrying it would only cost calls.
//   - the catalog (5%): exactly the fourteen free ids the brief lists, on the register body and on
//     both GET /v1/models answers.
//
// Everything is deterministic: candidate order, cooldowns and the trail are functions of the brief,
// the requests and the gateway's answers alone — no clock and no randomness, so a replay leaves the
// same state export byte for byte.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this baseline reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The free models that can serve a request, best first: rating_milli descending, id ascending as the
 * deterministic tie-break. Quality is 60% of the score and reads the rating of the model that really
 * served each prompt, so the first candidate is always the best eligible model for the prompt.
 */
function candidatesFor(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One refusal the gateway answered with, as the failover trail reports it. */
interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/** The prompt counter: every request the client sends, in arrival order. */
let requestIndex = 0;
/** Per-model cooldown: the request index before which a model that refused is not tried again. */
const cooldownUntil = new Map<string, number>();
/** Models refused with 400/401/403: the refusal is permanent for this trial (not diallable, not
 * allowed, or not authorised for this key), so they are never tried again — a retry would only cost
 * a gateway call. A 403 here is what OpenRouter answers for a model gated to agentic harnesses. */
const excluded = new Set<string>();

/** The code of a refused gateway call, from its error body when it names one. */
function failureCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code = parsed.error.code;
      if (typeof code === 'string' && code !== '') return code;
      if (typeof code === 'number') return String(code);
      const type = parsed.error.type;
      if (typeof type === 'string' && type !== '') return type;
    }
  } catch {
    // Not JSON: fall through to the status-based code.
  }
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'authentication_error';
  if (status === 400) return 'invalid_request_error';
  if (status >= 500) return 'upstream_error';
  return `http_${status}`;
}

/** The trail header's value for this prompt's refusals: at most 8 rows, in the order they refused. */
function failuresHeader(failures: readonly UpstreamFailure[]): string {
  return JSON.stringify(failures.slice(0, 8));
}

/**
 * Dial the candidates in order until one answers. A model that refuses cools down for the next two
 * requests (a rate-limited model must not take every later prompt down with it); a model that answers
 * clears its cooldown. Returns the model that answered with its response, or null when every eligible
 * model refused. Deterministic: the order and the cooldowns are functions of the brief, the requests
 * and the gateway's answers alone — no clock, no randomness.
 */
async function serveWithFailover(
  candidates: readonly ModelRow[],
  upstreamBody: Json,
): Promise<{ model: ModelRow | null; upstream: Response | null; failures: UpstreamFailure[] }> {
  const failures: UpstreamFailure[] = [];
  for (const model of candidates) {
    if (excluded.has(model.id)) continue;
    const cooledUntil = cooldownUntil.get(model.id) ?? 0;
    if (requestIndex < cooledUntil) continue;
    let upstream: Response;
    try {
      upstream = await dial(model.id, { ...upstreamBody, model: model.id });
    } catch (err) {
      failures.push({ status: 502, code: 'upstream_unreachable', model: model.id });
      cooldownUntil.set(model.id, requestIndex + 3);
      log(`refused: ${model.id} unreachable (${(err as Error).message})`);
      continue;
    }
    if (upstream.ok && upstream.body !== null) {
      cooldownUntil.delete(model.id);
      return { model, upstream, failures };
    }
    const text = await upstream.text();
    failures.push({ status: upstream.status, code: failureCode(upstream.status, text), model: model.id });
    if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
      excluded.add(model.id);
      log(`excluded: ${model.id} HTTP ${upstream.status} (${failures[failures.length - 1].code}) — not tried again this trial`);
    } else {
      cooldownUntil.set(model.id, requestIndex + 3);
      log(`refused: ${model.id} HTTP ${upstream.status} (${failures[failures.length - 1].code})`);
    }
  }
  return { model: null, upstream: null, failures };
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // TODO(workload): the brief's prompt list is the declared source of each request's requirements; this
  // fallback is a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, extraHeaders: Record<string, string> = {}): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), extraHeaders);
  else sendJson(res, status, openAIError(message, type, null), extraHeaders);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** Every eligible model refused: a 502 in the client's wire, carrying the refusal trail. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', failures: readonly UpstreamFailure[]): void {
  const headers = { 'x-makefun-upstream-failures': failuresHeader(failures) };
  const last = failures[failures.length - 1];
  const detail = last === undefined ? 'every free model refused' : `the gateway answered HTTP ${last.status} (${last.code})`;
  if (wire === 'anthropic') {
    sendError(res, wire, 502, 'api_error', detail, headers);
  } else {
    sendError(res, wire, 502, 'upstream_error', detail, headers);
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  requestIndex += 1;
  const candidates = candidatesFor(requirementsFor(body));
  if (candidates.length === 0) return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  const served = await serveWithFailover(candidates, body);
  if (served.model === null || served.upstream === null) return refused(res, 'openai', served.failures);
  const { model: route, upstream, failures } = served;
  const trail = failures.length > 0 ? { 'x-makefun-upstream-failures': failuresHeader(failures) } : {};
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body, route.id)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, route.id), trail);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  requestIndex += 1;
  const candidates = candidatesFor(requirementsFor(body));
  if (candidates.length === 0) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  const served = await serveWithFailover(candidates, anthropicToOpenAI(body, candidates[0].id));
  if (served.model === null || served.upstream === null) return refused(res, 'anthropic', served.failures);
  const { model: route, upstream, failures } = served;
  const trail = failures.length > 0 ? { 'x-makefun-upstream-failures': failuresHeader(failures) } : {};
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, route.id)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, route.id), trail);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
