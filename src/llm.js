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
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.llm.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.anthropicModel,
      max_tokens: maxTokens,
      system,
      messages: toAnthropic(messages),
      ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new LlmError(`Anthropic API error ${res.status}: ${json.error?.message || ''}`);
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

async function openaiComplete({ system, messages, tools, maxTokens = 2048 }) {
  const res = await fetch(`${config.llm.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.llm.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.llm.openaiModel,
      max_tokens: maxTokens,
      messages: toOpenAI(system, messages),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new LlmError(`LLM API error ${res.status}: ${json.error?.message || JSON.stringify(json).slice(0, 200)}`);
  const msg = json.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_call', id: tc.id, name: tc.function.name, input });
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
      onToolCall?.(call, output);
      results.push({ type: 'tool_result', id: call.id, name: call.name, output: JSON.stringify(output) });
    }
    convo.push({ role: 'tool', content: results });
  }
  return { text: 'I had to stop after several steps. Could you rephrase or break the request down?', messages: convo };
}
