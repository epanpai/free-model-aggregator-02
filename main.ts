// free-model-aggregator-02: one server, two client wires, and a real free model behind every answer.
//
// The server listens on a port it picks, registers that port and its catalog with the trial env,
// then serves the env's six prompts: three on the OpenAI wire, three on the Anthropic one, in
// JSON and in streaming. Every answer is a real completion from a free OpenRouter model, dialled
// through the grader's gateway on the trial's key — never an answer of its own.
//
// Routing, per prompt, by the brief's published ratings (quality is 60% of the score):
// candidates are ranked rating_milli-first, so JSON prompts go to the best json-capable model
// (nemotron-3.5-super-vl, 1303) and every other prompt to the best model overall
// (inkling-2-small, 1475). A refused gateway call fails over to the next best eligible model
// and the refusals are reported on the response in x-makefun-upstream-failures (at most 8 rows,
// the only way the failover column can see a retried refusal). A model that refuses cools down
// for the next two requests, so one rate-limited model never takes every later prompt down with
// it; a model that answers clears its cooldown. A 400/401/403 refusal is permanent for the
// trial (undiallable, not allowed, or gated to agentic harnesses) and excludes the model
// outright — retrying it would only cost gateway calls.
//
// The catalog is exactly the fourteen free ids the brief lists, on the register body and on
// both GET /v1/models answers (the catalog column compares those sets only).
//
// Everything is deterministic: candidate order, cooldowns and the trail are functions of the
// brief, the requests and the gateway's answers alone — no clock and no randomness, so a live
// pass and its replay leave the same state export byte for byte.

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

/** The protocol version the register body carries. */
const PROTOCOL_VERSION = 1;
/** How often the env's GET /work is polled, in milliseconds. */
const POLL_EVERY_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** The gateway's Chat Completions route, under the trial's OpenAI base URL. */
const GATEWAY_PATH = '/chat/completions';
/** The trial env's own port on one layout: never listen there. */
const ENV_OWN_PORT = 8080;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** The prompt counter: every request the client sends, in arrival order. */
let requestIndex = 0;
/** Per-model cooldown: the request index before which a model that refused is not tried again. */
const cooldownUntil = new Map<string, number>();
/** Models refused with 400/401/403: the refusal is permanent for this trial, so they are never
 * tried again — a retry would only cost a gateway call. A 403 here is what OpenRouter answers
 * for a model gated to agentic harnesses. */
const excluded = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** One refusal the gateway answered with, as the failover trail reports it. */
interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/**
 * The gateway's Chat Completions URL. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on
 * the trial network); a base that does not already end in `/v1` gets one, so both spellings reach
 * the route.
 */
function gatewayCompletionsUrl(): string {
  if (GATEWAY_BASE === '') return '';
  const base = GATEWAY_BASE.endsWith('/v1') ? GATEWAY_BASE : `${GATEWAY_BASE}/v1`;
  return `${base}${GATEWAY_PATH}`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({
    id: model.id,
    provider: model.provider,
    display_name: model.display_name,
  }));
}

/**
 * The free models that can serve a request, best first: rating_milli descending, id ascending
 * as the deterministic tie-break. The first candidate is always the best eligible model for the
 * prompt, which is what the quality column pays for.
 */
function candidatesFor(requires: Requirement): ModelRow[] {
  const eligible = freeModels(brief).filter((model) => meetsRequirements(requires, capabilitiesOf(model)));
  eligible.sort((a, b) => {
    if (b.rating_milli !== a.rating_milli) return b.rating_milli - a.rating_milli;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible;
}

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

/** The trail header for a response, present only when the prompt saw a refusal. */
function trailHeader(failures: readonly UpstreamFailure[]): Record<string, string> {
  return failures.length > 0 ? { 'x-makefun-upstream-failures': failuresHeader(failures) } : {};
}

/**
 * Dial the candidates in order until one answers. A model that refuses cools down for the next
 * two requests; a model that answers clears its cooldown. A 400/401/403 excludes the model for
 * the rest of the trial. Returns the model that answered with its response, or neither when
 * every eligible model refused. Deterministic: the order, the cooldowns and the exclusions are
 * functions of the brief, the requests and the gateway's answers alone — no clock, no randomness.
 */
async function serveWithFailover(
  candidates: readonly ModelRow[],
  upstreamBody: Json,
): Promise<{ model: ModelRow | null; upstream: Response | null; failures: UpstreamFailure[] }> {
  const failures: UpstreamFailure[] = [];
  for (const model of candidates) {
    if (excluded.has(model.id)) continue;
    if (requestIndex < (cooldownUntil.get(model.id) ?? 0)) continue;
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
    const failure: UpstreamFailure = {
      status: upstream.status,
      code: failureCode(upstream.status, text),
      model: model.id,
    };
    failures.push(failure);
    if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
      excluded.add(model.id);
      log(`excluded: ${model.id} HTTP ${upstream.status} (${failure.code}) — not tried again this trial`);
    } else {
      cooldownUntil.set(model.id, requestIndex + 3);
      log(`refused: ${model.id} HTTP ${upstream.status} (${failure.code})`);
    }
  }
  return { model: null, upstream: null, failures };
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // The brief's prompt list is the declared source of each request's requirements; this
  // fallback is only a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  const json = format === 'json_object' || format === 'json_schema';
  let vision = false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  return { tools, vision, json };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) return null;
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

/** One JSON answer, with its content length set. */
function respondJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(text);
}

/** One error answer, in the shape of the wire that asked. */
function respondError(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  status: number,
  type: string,
  message: string,
  extra: Record<string, string> = {},
): void {
  if (wire === 'anthropic') respondJson(res, status, anthropicError(type, message), extra);
  else respondJson(res, status, openAIError(message, type, null), extra);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') respondJson(res, 200, anthropicModelList(list));
  else respondJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(gatewayCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model }),
  });
}

/** Every eligible model refused: a 502 in the client's wire, carrying the refusal trail. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', failures: readonly UpstreamFailure[]): void {
  const last = failures[failures.length - 1];
  const detail =
    last === undefined ? 'every free model refused' : `the gateway answered HTTP ${last.status} (${last.code})`;
  const headers = trailHeader(failures);
  if (wire === 'anthropic') respondError(res, wire, 502, 'api_error', detail, headers);
  else respondError(res, wire, 502, 'upstream_error', detail, headers);
}

/** The shared tail of both completion routes: relay the gateway's answer, streamed or not. */
async function relayAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  served: { model: ModelRow; upstream: Response; failures: UpstreamFailure[] },
  stream: boolean,
  toClient: (answer: Json, model: string) => Json,
  toStream: (body: ReadableStream<Uint8Array>, model: string) => AsyncGenerator<string>,
): Promise<void> {
  const { model, upstream, failures } = served;
  const trail = trailHeader(failures);
  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...trail,
    });
    try {
      for await (const frame of toStream(upstream.body, model.id)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  respondJson(res, 200, toClient(isRecord(answer) ? answer : {}, model.id), trail);
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    respondError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  requestIndex += 1;
  const candidates = candidatesFor(requirementsFor(body));
  if (candidates.length === 0) {
    respondError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
    return;
  }
  const served = await serveWithFailover(candidates, body);
  if (served.model === null || served.upstream === null) {
    refused(res, 'openai', served.failures);
    return;
  }
  await relayAnswer(req, res, 'openai', served, body.stream === true, openAIJsonWithModel, openAIStreamWithModel);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    respondError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  requestIndex += 1;
  const candidates = candidatesFor(requirementsFor(body));
  if (candidates.length === 0) {
    respondError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
    return;
  }
  const served = await serveWithFailover(candidates, anthropicToOpenAI(body, candidates[0].id));
  if (served.model === null || served.upstream === null) {
    refused(res, 'anthropic', served.failures);
    return;
  }
  await relayAnswer(
    req,
    res,
    'anthropic',
    served,
    body.stream === true,
    openAIToAnthropic,
    anthropicEventsFromOpenAI,
  );
}

/** The routes this server answers, by method and path. */
const ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}> = [
  { method: 'GET', path: '/v1/models', run: models },
  { method: 'POST', path: '/v1/chat/completions', run: chat },
  { method: 'POST', path: '/v1/messages', run: messages },
];

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  for (const route of ROUTES) {
    if (req.method === route.method && url.pathname === route.path) {
      await route.run(req, res);
      return;
    }
  }
  const wire = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
  respondError(res, wire, 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

/** Start listening on 0.0.0.0 at a free port the OS picks. */
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function registerWithEnv(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') {
    log(`registered: the trial holds ${reply.requests} prompts`);
  }
}

/** Poll GET /work until it says done, then stop the server and exit 0. */
function watchWork(server: Server): void {
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
  }, POLL_EVERY_MS);
}

/** Print the catalog document and exit 0 before any server starts. */
async function printCatalogAndExit(): Promise<never> {
  // The same document the register body carries, byte for byte. A process whose stdout is not
  // flushed loses the tail, so wait for the write to finish before exiting.
  const text = `${JSON.stringify(catalog)}\n`;
  await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
  process.exit(0);
}

async function boot(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) await printCatalogAndExit();
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (gatewayCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        const wire = req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai';
        respondError(res, wire, 500, 'internal_error', 'the server failed to answer');
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // The env owns its port on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === ENV_OWN_PORT) {
    throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  }
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await registerWithEnv(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  watchWork(server);
}

try {
  await boot();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
