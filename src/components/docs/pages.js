import Intro from './content/intro.mdx'
import GettingStarted from './content/getting-started.mdx'
import Releases from './content/releases.mdx'
import Gate from './content/gate.mdx'
import CodeStructure from './content/code-structure.mdx'
import HowItWorks from './content/how-it-works.mdx'
import Harnesses from './content/harnesses.mdx'
import ClaudeCode from './content/claude-code.mdx'
import Codex from './content/codex.mdx'
import Hermes from './content/hermes.mdx'
import ClaudeCodeHooks from './content/claude-code-hooks.mdx'
import CodexHooks from './content/codex-hooks.mdx'
import HermesHooks from './content/hermes-hooks.mdx'
import Models from './content/models.mdx'
import ModelMiniLM from './content/models/minilm/index.mdx'
import ModelGLiNER from './content/models/gliner/index.mdx'
import ContextPipeline from './content/context-pipeline.mdx'
import Repl from './content/repl.mdx'
import Database from './content/database.mdx'
import PluginsAndMcps from './content/plugins-and-mcps.mdx'

export const pages = [
  {
    slug: '',
    title: 'Introduction',
    description: 'Analyze prompt wording, outcomes, warnings, and model changes across local sessions.',
    sections: ['The problem', 'What CheatingKit does', 'Research basis'],
    Content: Intro,
  },
  {
    slug: 'getting-started',
    title: 'Getting started',
    description: 'Install ck from cheatingkit.com and start using local sessions.',
    sections: ['Install CheatingKit', 'Set up local sessions', 'Enable the per-message gate', 'Inspect your history', 'Keep ck current'],
    Content: GettingStarted,
  },
  { slug: 'releases', title: 'Releases and installation', description: 'Install ck from the website and choose stable, nightly, or pinned versions.', sections: ['Install from the website', 'Choose a release', 'Update ck', 'How a version is published', 'Credentials for the proxy and gate'], Content: Releases },
  { slug: 'gate', title: 'The per-message gate', description: 'How a request is checked before it is forwarded to the provider.', sections: ['Where the gate sits', 'What the gate checks', 'Revisions', 'Records', 'Rollout', 'Limits'], Content: Gate },
  { slug: 'code-structure', title: 'Code structure', description: 'Capability ownership and naming conventions.', sections: ['Naming rules', 'Ownership', 'Keeping docs in sync'], Content: CodeStructure },
  {
    slug: 'how-it-works',
    title: 'How it works',
    description: 'The high-level approach behind CheatingKit.',
    sections: ['The context problem', 'The approach', 'The provider proxy and the gate'],
    Content: HowItWorks,
  },
  { slug: 'harnesses', title: 'Harnesses', description: 'Local session sources and indexing.', sections: ['Sources', 'What is indexed', 'Harness boundaries'], Content: Harnesses },
  { slug: 'harnesses/claude-code', title: 'Claude Code', description: 'Import Claude Code sessions.', sections: ['Import', 'Integration', 'Related'], Content: ClaudeCode },
  { slug: 'harnesses/claude-code/hooks', title: 'Claude Code hooks', description: 'Claude Code hook boundary.', sections: ['Event flow', 'Installation'], Content: ClaudeCodeHooks },
  { slug: 'harnesses/codex', title: 'Codex', description: 'Import Codex sessions.', sections: ['Import', 'Integration', 'Model changes'], Content: Codex },
  { slug: 'harnesses/codex/hooks', title: 'Codex hooks', description: 'Codex hook boundary.', sections: ['Event flow', 'Installation'], Content: CodexHooks },
  { slug: 'harnesses/hermes', title: 'Hermes', description: 'Import Hermes sessions.', sections: ['Import', 'Integration', 'Model changes'], Content: Hermes },
  { slug: 'harnesses/hermes/hooks', title: 'Hermes hooks', description: 'Hermes hook boundary.', sections: ['Event flow', 'Installation'], Content: HermesHooks },
  { slug: 'harnesses/plugins-and-mcps', title: 'Plugins and MCPs', description: 'Extension boundaries across harnesses.', sections: ['Claude Code', 'Codex', 'Hermes', 'Indexing rule'], Content: PluginsAndMcps },
  { slug: 'models', title: 'Models', description: 'Exact local models and their roles.', sections: ['Model roles', 'Why local', 'Processing example'], Content: Models },
  { slug: 'models/minilm', title: 'MiniLM embeddings', description: 'Exact local embedding model, operation, examples, and files.', sections: ['How it works', 'Why this model', 'Exact use example', 'Pinned files'], Content: ModelMiniLM },
  { slug: 'models/gliner', title: 'GLiNER 2.5 screening', description: 'Exact local extraction model, operation, examples, and files.', sections: ['How it works', 'Why this model', 'Exact use example', 'Pinned files'], Content: ModelGLiNER },
  { slug: 'models/context-pipeline', title: 'Local context and search', description: 'Incremental indexing, retrieval, harness delivery, and gate input.', sections: ['Import and index', 'Per-message recall', 'Harness delivery', 'Gate input', 'Scope of the index'], Content: ContextPipeline },
  { slug: 'repl', title: 'The RLM environment', description: 'Work in a persistent workspace where the prompt is a variable.', sections: ['Open an environment', 'Run a cell', 'Rounds', 'From the proxy', 'Ask the gate', 'Capabilities', 'Through MCP', 'Storage'], Content: Repl },
  { slug: 'database', title: 'Database design', description: 'SQLite source records, projections, and cursors.', sections: ['Source and projections', 'Cursors and recovery', 'Time and identity', 'Private data', 'Rebuild contract'], Content: Database },
]

export function docsHref(slug) {
  return slug ? `/docs/${slug}` : '/docs'
}

export function headingId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
