import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = join(process.env.USERPROFILE, '.cheatingkit')
copyFileSync(join(home, 'proxy-secrets', 'analysis.key'), join(home, 'proxy-secrets', 'codex.key'))
writeFileSync(join(home, 'proxy-provider.json'), JSON.stringify({ provider: 'custom-responses', upstreamBaseUrl: 'https://api.venice.ai/api/v1', model: 'deepseek-v4-1-flash-1017-uncensored', apiKeyEnv: null, apiKeySource: 'local' }, null, 2))
console.log('main route now uses a stored key')
