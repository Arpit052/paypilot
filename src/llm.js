// Provider-neutral LLM client with tool calling.
// Supports Anthropic (Claude) and any OpenAI-compatible Chat Completions API
// (OpenAI, Gemini's OpenAI endpoint, Groq, OpenRouter, local models...).
//
// Neutral message format:
//   { role: 'user', content: [{type:'text', text} | {type:'image', mediaType, data}] }
//   { role: 'assistant', content: [{type:'text', text} | {type:'tool_call', id, name, input}] }
//   { role: 'tool', content: [{type:'tool_result', id, name, output}] }
import { config } from './config.js';

export class LlmError extends Error {}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);
// per attempt; a slow Gemini model falls through to the next fallback instead of hanging
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 40000);

/** POST JSON to an LLM API with a timeout and a one-line log in the server console. */
async function postJson(url, headers, body, label) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      console.log(`  [AI] ${label}: no answer after ${secs}s (timeout)`);
      throw new LlmError(`The AI did not answer within ${TIMEOUT_MS / 1000} seconds. Check your internet connection and try again.`);
    }
    const why = e.cause?.code || e.cause?.message || e.message;
    console.log(`  [AI] ${label}: network error after ${secs}s: ${why}`);
    throw new LlmError(`Could not reach the AI server (${why}). Check your internet connection.`);
  }
  const json = await res.json().catch(() => ({}));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [AI] ${label}: HTTP ${res.status} in ${secs}s`);
  if (!res.ok) {
    const err = Array.isArray(json) ? json[0]?.error : json.error;
    throw new LlmError(`AI API error ${res.status}: ${err?.message || JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// ---------------- Anthropic ----------------
export function toAnthropic(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.content.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: c.output })),
      };
    }
    return {
      role: m.role,
      content: m.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        if (c.type === 'image') return { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } };
        if (c.type === 'tool_call') return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
        throw new LlmError('Unknown content type ' + c.type);
      }),
    };
  });
}

async function anthropicComplete({ system, messages, tools, maxTokens = 2048 }) {
  const json = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': config.llm.anthropicKey, 'anthropic-version': '2023-06-01' },
    {
      model: config.llm.anthropicModel,
      max_tokens: maxTokens,
      system,
      messages: toAnthropic(messages),
      ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    },
    config.llm.anthropicModel
  );
  const content = [];
  for (const b of json.content || []) {
    if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
    if (b.type === 'tool_use') content.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input || {} });
  }
  return { content };
}

// ---------------- OpenAI-compatible ----------------
export function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      for (const c of m.content) out.push({ role: 'tool', tool_call_id: c.id, content: c.output });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const calls = m.content.filter((c) => c.type === 'tool_call');
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
          // Gemini returns a "thought signature" that must be sent back with the call
          ...(c.extra ? { extra_content: c.extra } : {}),
        }));
      }
      out.push(msg);
    } else {
      out.push({
        role: 'user',
        content: m.content.map((c) =>
          c.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${c.mediaType};base64,${c.data}` } }
            : { type: 'text', text: c.text }
        ),
      });
    }
  }
  return out;
}

async function openaiComplete({ system, messages, tools, maxTokens = 4096 }) {
  const base = config.llm.openaiBaseUrl;
  const isGemini = base.includes('generativelanguage.googleapis.com');
  const json = await postJson(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${config.llm.openaiKey}` },
    {
      model: config.llm.openaiModel,
      max_tokens: maxTokens,
      messages: toOpenAI(system, messages),
      // keep Gemini's "thinking" short so replies come back fast
      ...(isGemini ? { reasoning_effort: process.env.GEMINI_REASONING || 'low' } : {}),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    },
    config.llm.openaiModel
  );
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  (msg.tool_calls || []).forEach((tc, i) => {
    let input = tc.function?.arguments ?? {};
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input || '{}');
      } catch {
        input = {};
      }
    }
    content.push({
      type: 'tool_call',
      id: tc.id || `call_${Date.now()}_${i}`,
      name: tc.function?.name,
      input,
      ...(tc.extra_content ? { extra: tc.extra_content } : {}),
    });
  });
  if (!content.length) {
    console.log(`  [AI] empty reply (finish_reason: ${choice.finish_reason || 'unknown'})`);
  }
  return { content };
}

// ---------------- Google Gemini (native generateContent API) ----------------
// Thought signatures are tied to the model that produced them. When a conversation moves
// to a fallback model, Gemini accepts this documented placeholder instead.
const FOREIGN_SIGNATURE = 'skip_thought_signature_validator';

export function toGemini(messages, model) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: m.content.map((c) => {
          let response;
          try {
            response = JSON.parse(c.output);
          } catch {
            response = { result: c.output };
          }
          if (response === null || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
          return { functionResponse: { name: c.name, response, ...(c.extra?.callId ? { id: c.extra.callId } : {}) } };
        }),
      };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.content.map((c) => {
        const own = c.extra?.thoughtSignature && (!c.extra.sigModel || !model || c.extra.sigModel === model);
        const sig = c.extra?.thoughtSignature ? { thoughtSignature: own ? c.extra.thoughtSignature : FOREIGN_SIGNATURE } : {};
        if (c.type === 'text') return { text: c.text, ...sig };
        if (c.type === 'image') return { inlineData: { mimeType: c.mediaType, data: c.data } };
        if (c.type === 'tool_call') {
          return { functionCall: { name: c.name, args: c.input || {}, ...(c.extra?.callId ? { id: c.extra.callId } : {}) }, ...sig };
        }
        throw new LlmError('Unknown content type ' + c.type);
      }),
    };
  });
}

let genai = null;
async function geminiClient() {
  if (!genai) {
    const { GoogleGenAI } = await import('@google/genai');
    genai = new GoogleGenAI({ apiKey: config.llm.geminiKey });
  }
  return genai;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-model cool-downs after a rate limit / overload, and models that reject thinkingLevel.
const cooldownUntil = new Map();
const noThinking = new Set();

function classify(e) {
  const msg = e.message || '';
  if (e.rateLimited || /exceeded your current quota|RESOURCE_EXHAUSTED|\b429\b/i.test(msg)) return 'rate';
  if (/high demand|overloaded|UNAVAILABLE|\b503\b|timed? ?out|did not answer/i.test(msg)) return 'busy';
  if (/no longer available|not found|is not supported for generateContent|\b404\b/i.test(msg)) return 'missing';
  if (/thinking level|thinking_level|thinkingConfig|thinking is not supported/i.test(msg)) return 'thinking';
  return 'other';
}

/**
 * Gemini call with resilience for free-tier keys:
 *  - tries the primary model, then GEMINI_FALLBACK_MODELS (each model has its own quota)
 *  - models that are rate-limited/overloaded get a short cool-down
 *  - if every model is limited, waits once for the shortest retry window
 */
async function geminiComplete(args) {
  const models = [config.llm.geminiModel, ...config.llm.geminiFallbacks.filter((m) => m !== config.llm.geminiModel)];
  // quick structured jobs (reading a business description) go to the light models first
  if (args.fast) models.sort((a, b) => Number(/lite/.test(b)) - Number(/lite/.test(a)));
  let waited = false;
  for (;;) {
    let lastErr = null;
    let shortestRetry = Infinity;
    for (const model of models) {
      if ((cooldownUntil.get(model) || 0) > Date.now()) continue;
      try {
        return await geminiOnce({ ...args, model });
      } catch (e) {
        let kind = classify(e);
        if (kind === 'thinking' && !noThinking.has(model)) {
          noThinking.add(model); // retry this model once without a thinking level
          try {
            return await geminiOnce({ ...args, model });
          } catch (e2) {
            e = e2;
            kind = classify(e2);
          }
        }
        lastErr = e;
        if (kind === 'other') throw e;
        const retry = Number(/retry in ([\d.]+)s/i.exec(e.message || '')?.[1]);
        const coolSecs = kind === 'missing' ? 3600 : Number.isFinite(retry) ? retry + 1 : kind === 'busy' ? 30 : 20;
        cooldownUntil.set(model, Date.now() + coolSecs * 1000);
        shortestRetry = Math.min(shortestRetry, coolSecs);
        console.log(`  [AI] ${model} ${kind === 'rate' ? 'rate-limited' : kind === 'busy' ? 'busy' : 'unavailable'} - trying next model`);
      }
    }
    // every model is cooling down: wait once (max 30s) for the earliest one, then give up
    const nextFree = Math.min(...models.map((m) => cooldownUntil.get(m) || 0));
    const waitMs = Math.max(0, Math.min(Number.isFinite(shortestRetry) ? shortestRetry * 1000 : nextFree - Date.now(), nextFree - Date.now()));
    if (waited || waitMs > 30000) {
      if (lastErr && classify(lastErr) === 'busy') throw new LlmError('Gemini is very busy right now. Please try again in a minute.');
      throw new LlmError('Gemini free-tier limit reached on all models. Wait about a minute and try again (a paid key removes this limit).');
    }
    waited = true;
    console.log(`  [AI] all models limited - waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs + 250);
  }
}

async function geminiOnce({ system, messages, tools, maxTokens = 4096, model = config.llm.geminiModel }) {
  const thinking = noThinking.has(model) ? 'off' : config.llm.geminiThinking;
  const ai = await geminiClient();
  const t0 = Date.now();
  let resp;
  try {
    resp = await ai.models.generateContent({
      model,
      contents: toGemini(messages, model),
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        ...(thinking && thinking !== 'off' ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
        ...(tools?.length
          ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] }
          : {}),
        abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      },
    });
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || /abort/i.test(e.message)) {
      console.log(`  [AI] ${model}: no answer after ${secs}s (timeout)`);
      throw new LlmError(`The AI did not answer within ${GEMINI_TIMEOUT_MS / 1000} seconds. Try again.`);
    }
    let msg = e.message || String(e);
    try {
      msg = JSON.parse(msg.slice(msg.indexOf('{'))).error?.message || msg;
    } catch {
      /* keep raw */
    }
    const rateLimited = e.status === 429 || /exceeded your current quota|RESOURCE_EXHAUSTED/i.test(msg);
    console.log(`  [AI] ${model}: ${rateLimited ? 'rate limited' : 'error'} after ${secs}s${rateLimited ? '' : ': ' + msg.slice(0, 200)}`);
    const retry = /retry in ([\d.]+)s/i.exec(e.message || '');
    throw Object.assign(new LlmError(`AI error: ${msg}${retry ? ` (retry in ${retry[1]}s)` : ''}`), { rateLimited });
  }
  console.log(`  [AI] ${model}: OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const cand = resp.candidates?.[0];
  const content = [];
  (cand?.content?.parts || []).forEach((p, i) => {
    if (p.thought) return; // internal reasoning summary - not shown
    const extra = {};
    if (p.thoughtSignature) {
      extra.thoughtSignature = p.thoughtSignature;
      extra.sigModel = model;
    }
    if (p.functionCall) {
      if (p.functionCall.id) extra.callId = p.functionCall.id;
      content.push({ type: 'tool_call', id: p.functionCall.id || `g_${Date.now()}_${i}`, name: p.functionCall.name, input: p.functionCall.args || {}, extra });
    } else if (typeof p.text === 'string' && p.text.trim()) {
      content.push({ type: 'text', text: p.text, ...(extra.thoughtSignature ? { extra } : {}) });
    }
  });
  if (!content.length) {
    console.log(`  [AI] empty reply (finishReason: ${cand?.finishReason || resp.promptFeedback?.blockReason || 'unknown'})`);
  }
  return { content };
}

// ---------------- dispatch ----------------
let override = null;
/** Tests can inject a fake provider: fn({system, messages, tools}) => {content} */
export function setLlmOverride(fn) {
  override = fn;
}

export function llmAvailable() {
  return Boolean(override) || config.llm.provider !== 'none';
}

export async function complete(args) {
  if (override) return override(args);
  if (config.llm.provider === 'anthropic') return anthropicComplete(args);
  if (config.llm.provider === 'openai') return openaiComplete(args);
  if (config.llm.provider === 'gemini') return geminiComplete(args);
  throw new LlmError('No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env');
}

/**
 * Agent loop: call the model, run any tools it asks for, feed results back,
 * repeat until it answers in plain text (or we hit maxSteps).
 * `handlers` maps tool name -> async (input) => any (JSON-serialisable).
 */
export async function runToolLoop({ system, messages, tools, handlers, maxSteps = 8, onToolCall }) {
  const convo = [...messages];
  for (let step = 0; step < maxSteps; step++) {
    const { content } = await complete({ system, messages: [...convo], tools });
    convo.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no response)' }] });
    const calls = content.filter((c) => c.type === 'tool_call');
    if (!calls.length) {
      return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(), messages: convo };
    }
    const results = [];
    for (const call of calls) {
      let output;
      try {
        const h = handlers[call.name];
        if (!h) throw new Error(`Unknown tool ${call.name}`);
        output = await h(call.input || {});
      } catch (e) {
        output = { error: e.message };
      }
      console.log(`  [AI]   tool ${call.name}${output?.error ? ' → error: ' + output.error : ''}`);
      onToolCall?.(call, output);
      results.push({ type: 'tool_result', id: call.id, name: call.name, output: JSON.stringify(output), ...(call.extra ? { extra: call.extra } : {}) });
    }
    convo.push({ role: 'tool', content: results });
  }
  return { text: 'I had to stop after several steps. Could you rephrase or break the request down?', messages: convo };
}
