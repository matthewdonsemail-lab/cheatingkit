// Extract data supplied by the harness without treating it as evaluator instructions.
export function requestContext(body) {
  const messages = body.input || body.messages
  const texts = Array.isArray(messages) ? messages.map((item) => ({ role: item?.role, text: typeof item?.content === 'string' ? item.content : (item?.content || []).map?.((part) => part?.text || '').join('\n') || '' })) : []
  const environment = texts.filter((item) => item.role === 'user' && item.text.includes('<environment_context>')).at(-1)?.text || ''
  const cwd = environment.match(/<cwd>([^<]+)<\/cwd>/)?.[1]?.trim()
  const hookEvidence = texts.filter((item) => item.role === 'developer' && item.text.startsWith('CheatingKit local session evidence.')).map((item) => item.text).join('\n').slice(0, 9000)
  return { cwd, hookEvidence }
}
