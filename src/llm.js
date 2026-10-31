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
      results.push({ type: 'tool_result', id: call.id, name: call.name, output: JSON.stringify(output) });
    }
    convo.push({ role: 'tool', content: results });
  }
  return { text: 'I had to stop after several steps. Could you rephrase or break the request down?', messages: convo };
}
