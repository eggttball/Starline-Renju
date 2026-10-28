import { analyzeMove, BLACK, WHITE } from './rules.mjs';

const FORMATS = new Set(['agent-json', 'openai-chat', 'openai-responses']);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REASON_LENGTH = 1000;

export class AgentError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeConfig(config = {}) {
  return {
    apiKey: typeof config.apiKey === 'string' ? config.apiKey.trim() : '',
    endpoint: typeof config.endpoint === 'string' ? config.endpoint.trim() : '',
    model: typeof config.model === 'string' ? config.model.trim() : '',
    format: typeof config.format === 'string' && config.format ? config.format.trim() : 'openai-chat',
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 45_000,
  };
}

function configurationIssue(config) {
  if (!config.apiKey || !config.endpoint) return '請先在伺服器的 .env 設定 AI_API_KEY 與 AI_API_ENDPOINT，再重試電腦落子。';
  if (!FORMATS.has(config.format)) return 'AI_API_FORMAT 必須是 agent-json、openai-chat 或 openai-responses。';
  try {
    const endpoint = new URL(config.endpoint);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
  } catch {
    return 'AI_API_ENDPOINT 必須是完整的 HTTP 或 HTTPS API 網址。';
  }
  if (config.format !== 'agent-json' && !config.model) return '請在伺服器的 .env 設定 AI_API_MODEL，再重試電腦落子。';
  return null;
}

export function publicConfig(config) {
  const result = { configured: !configurationIssue(config), format: FORMATS.has(config.format) ? config.format : 'openai-chat' };
  if (config.model) result.model = config.model;
  return result;
}

function buildPayload(state, config) {
  const color = state.color === WHITE ? 'white' : 'black';
  const request = `Choose exactly one ${color} move from legalMoves. Return only JSON: {"move":{"row":0,"col":0},"reason":"brief explanation","winRate":0.5}. winRate must be your newest estimated probability that ${color} wins after this move, a number from 0 to 1; it is an estimate, not an empirical statistic. Coordinates are zero-based integers from 0 through 14. Never choose an occupied, forbidden, or excluded point.`
    + (state.preferredMove ? ' A preferredMove is supplied: return that exact move and independently re-evaluate its newest winRate; do not substitute another move.' : ' Independently evaluate the current position and select a move.');
  const input = { rules: 'RIF', board: state.board, moves: state.moves, color, legalMoves: state.legalMoves, request };
  if (state.preferredMove) input.preferredMove = { row: state.preferredMove.row, col: state.preferredMove.col };
  if (config.format === 'agent-json') return input;
  const instructions = `You play ${color} in Renju on a 15×15 board under RIF rules. Black wins with an exact five; black overline, double-four and genuine double-three are forbidden. White wins with five or more in a row and has no forbidden move restrictions. The opening has finished. The server supplies the currently permitted legalMoves after exclusions. Select only from legalMoves. Board is a row-major array of 225 cells: 0 empty, 1 black, 2 white. ` + request;
  if (config.format === 'openai-chat') {
    return { model: config.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(input) }] };
  }
  return { model: config.model, instructions, input: JSON.stringify(input) };
}

function parseAgentOutput(response, colorLabel) {
  if (response && typeof response === 'object' && response.move) return response;
  let content;
  if (typeof response?.choices?.[0]?.message?.content === 'string') content = response.choices[0].message.content;
  else if (typeof response?.output_text === 'string') content = response.output_text;
  else if (Array.isArray(response?.output)) {
    content = response.output.flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text).join('');
  }
  if (typeof content !== 'string' || !content.trim()) throw new AgentError('invalid-agent-response', `${colorLabel} API 未回傳可讀的 JSON 落子；盤面已保留，請重試。`);
  content = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content);
  if (fenced) content = fenced[1];
  try {
    return JSON.parse(content);
  } catch {
    throw new AgentError('invalid-agent-response', `${colorLabel} API 的內容不是有效 JSON；盤面已保留，請重試。`);
  }
}

async function readBoundedBody(response, signal, colorLabel) {
  if (!response.body) throw new AgentError('invalid-agent-response', `${colorLabel} API 回應內容為空；盤面已保留，請重試。`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    void response.body.cancel().catch(() => {});
    throw new AgentError('invalid-agent-response', `${colorLabel} API 回應內容過大；盤面已保留，請重試。`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new AgentError('invalid-agent-response', `${colorLabel} API 回應內容過大；盤面已保留，請重試。`);
      }
      chunks.push(value);
    }
    if (signal.aborted) throw signal.reason;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function requestAgent(state, { config, fetchImpl = fetch, signal }) {
  const color = state.color ?? BLACK;
  if (color !== BLACK && color !== WHITE) throw new AgentError('invalid-state', '電腦行動方必須是黑方 1 或白方 2。', 400);
  const colorLabel = color === WHITE ? '白棋' : '黑棋';
  const abortError = new DOMException(`${colorLabel} API 請求已取消。`, 'AbortError');
  if (signal?.aborted) throw abortError;
  const issue = configurationIssue(config);
  if (issue) throw new AgentError('not-configured', issue, 503);
  const controller = new AbortController();
  const timeoutError = new AgentError('api-timeout', `${colorLabel} API 等待逾時；盤面已保留，請檢查連線並重試。`, 504);
  const onClientAbort = () => controller.abort(abortError);
  signal?.addEventListener('abort', onClientAbort, { once: true });
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  const onInterrupted = () => rejectInterrupted(controller.signal.reason);
  controller.signal.addEventListener('abort', onInterrupted, { once: true });
  const timeout = setTimeout(() => controller.abort(timeoutError), config.timeoutMs);
  try {
    const remote = async () => {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(buildPayload(state, config)),
        signal: controller.signal,
        redirect: 'error',
      });
      if (controller.signal.aborted) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw controller.signal.reason;
      }
      if (!response.ok) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new AgentError('api-upstream', `${colorLabel} API 回傳 HTTP ${response.status}；請檢查伺服器 API 設定後重試。`);
      }
      const text = await readBoundedBody(response, controller.signal, colorLabel);
      let result;
      try { result = JSON.parse(text); } catch {
        throw new AgentError('invalid-agent-response', `${colorLabel} API 回應不是有效 JSON；盤面已保留，請重試。`);
      }
      const output = parseAgentOutput(result, colorLabel);
      const { row, col } = output?.move ?? {};
      const winRate = output?.winRate ?? null;
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= 15 || col < 0 || col >= 15
        || typeof output.reason !== 'string' || output.reason.length > MAX_REASON_LENGTH
        || (winRate !== null && (!Number.isFinite(winRate) || winRate < 0 || winRate > 1))) {
        throw new AgentError('invalid-agent-response', `${colorLabel} API 的座標、說明或勝率格式無效；盤面已保留，請重試。`);
      }
      if (!state.legalMoves.some((point) => point.row === row && point.col === col)) {
        throw new AgentError('invalid-agent-response', `${colorLabel} API 選了已佔用、禁手或已排除的落點；盤面已保留，請重試。`);
      }
      if (state.preferredMove && (state.preferredMove.row !== row || state.preferredMove.col !== col)) throw new AgentError('invalid-agent-response', `${colorLabel} API 沒有回傳本次指定評估的落點；盤面已保留，請重試。`);
      const analysis = analyzeMove(state.board, row, col, color);
      if (!analysis.legal) throw new AgentError('invalid-agent-response', `${colorLabel} API 選了非法落點（${analysis.reason}）；盤面已保留，請重試。`);
      const reason = output.reason.includes(config.apiKey) || output.reason.includes(config.endpoint)
        ? 'API 回傳的說明含有伺服器設定，已省略。'
        : output.reason.trim();
      return { move: { row, col }, reason, winRate };
    };
    return await Promise.race([remote(), interrupted]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof AgentError) throw error;
    throw new AgentError('api-upstream', `無法連線至${colorLabel} API；請檢查伺服器 API 設定與網路後重試。`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onClientAbort);
    controller.signal.removeEventListener('abort', onInterrupted);
  }
}
