#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_OUTPUT_FILE = path.resolve(process.cwd(), 'data/model-capabilities.json');

const DOC_SOURCES = [
  {
    id: 'azure-openai',
    name: 'Azure OpenAI in Microsoft Foundry Models',
    url: 'https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/articles/foundry/openai/includes/models-azure-direct-openai.md',
  },
  {
    id: 'azure-direct-others',
    name: 'Other Foundry Models sold by Azure',
    url: 'https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/articles/foundry/foundry-models/includes/models-azure-direct-others.md',
  },
  {
    id: 'partners',
    name: 'Foundry Models from partners and community',
    url: 'https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/articles/foundry/foundry-models/includes/models-partners.md',
  },
];

const CAPABILITY_TAGS = [
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'tool-calling', label: 'Tool calling' },
  { id: 'structured-outputs', label: 'Structured outputs' },
  { id: 'fine-tuning', label: 'Fine-tuning' },
  { id: 'realtime', label: 'Realtime' },
  { id: 'batch', label: 'Batch' },
];

function parseArgs(argv) {
  const options = {};

  for (const arg of argv) {
    if (arg.startsWith('--output=')) {
      options.outputFile = arg.slice('--output='.length);
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/update-capabilities.js [options]

Fetch MicrosoftDocs markdown and generate data/model-capabilities.json.

Options:
  --output=PATH           Output file, defaults to ./data/model-capabilities.json
  --timeout-ms=N          Per-request timeout, defaults to ${DEFAULT_TIMEOUT_MS}
`);
}

async function fetchText(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available. Use Node 18+ or inject fetchImpl.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'text/markdown,text/plain,*/*' },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = typeof response.text === 'function' ? await response.text() : '';
      throw new Error(`GET ${url} failed with ${response.status}: ${body.slice(0, 500)}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, (match) => {
      const label = match.match(/^\[([^\]]+)\]/);
      return label ? label[1] : match;
    })
    .replace(/[`*_]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeModelKey(value) {
  return stripMarkdown(value)
    .toLowerCase()
    .replace(/\bpreview\b/g, ' ')
    .replace(/\bga\b/g, ' ')
    .replace(/\bversion\s+\d+\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

function extractModelAliases(cell) {
  const aliases = new Set();
  const text = String(cell || '');
  const codeMatches = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

  for (const code of codeMatches) {
    const cleaned = stripMarkdown(code);
    if (isPlausibleModelName(cleaned)) {
      aliases.add(cleaned);
    }
  }

  if (!aliases.size) {
    const beforeBreak = text.split(/<br\s*\/?>/i)[0];
    const cleaned = stripMarkdown(beforeBreak).replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (isPlausibleModelName(cleaned)) {
      aliases.add(cleaned);
    }
  }

  return [...aliases];
}

function isPlausibleModelName(value) {
  const text = stripMarkdown(value);
  if (!text || text.length < 2 || text.length > 90) return false;
  if (/^(model|models|region|error|evaluation benchmark|miracl average|mteb average|audio|embeddings?|image generation|video generation|fine-tuning models?|assistants?)$/i.test(text)) return false;
  if (/^[-:\s]+$/.test(text)) return false;
  return /[a-z0-9]/i.test(text);
}

function inferProviderFromHeading(heading) {
  const text = stripMarkdown(heading)
    .replace(/\s+models\s+sold\s+by\s+azure$/i, '')
    .trim();

  return text && !/^model\b/i.test(text) ? text : null;
}

function inferCapabilities(text) {
  const lower = stripMarkdown(text).toLowerCase();
  const tags = new Set();

  if (/\breason(?:ing)?\b/.test(lower) || /reasoning content/.test(lower)) tags.add('reasoning');
  if (/\baudio\b|\bspeech\b|transcri|text-to-speech|\btts\b|whisper/.test(lower)) tags.add('audio');
  if (/\bimages?\b|\bvision\b|text-to-image|image-to-|images?\/generations/.test(lower)) tags.add('image');
  if (/\bvideo\b|\bsora\b/.test(lower)) tags.add('video');
  if (/\bembedding\b|\bembeddings\b|\bvector\b/.test(lower)) tags.add('embeddings');
  if (/tool calling|function calling|functions?[, ]+tools?|parallel tool/.test(lower)) tags.add('tool-calling');
  if (/structured outputs?|response formats?:?[^|]*(json)|json mode/.test(lower)) tags.add('structured-outputs');
  if (/fine[- ]?tun/.test(lower)) tags.add('fine-tuning');
  if (/realtime|real-time|low latency/.test(lower)) tags.add('realtime');
  if (/\bbatch\b/.test(lower)) tags.add('batch');

  return [...tags];
}

function addEntry(entries, alias, context) {
  const key = normalizeModelKey(alias);
  if (!key) return;

  const existing = entries.get(key) || {
    modelName: stripMarkdown(alias),
    aliases: new Set(),
    provider: context.provider || null,
    capabilities: new Set(),
    sources: new Set(),
  };

  existing.aliases.add(stripMarkdown(alias));
  if (!existing.provider && context.provider) {
    existing.provider = context.provider;
  }
  for (const tag of context.capabilities || []) {
    existing.capabilities.add(tag);
  }
  if (context.sourceId) {
    existing.sources.add(context.sourceId);
  }

  entries.set(key, existing);
}

function parseMarkdownSource(source, markdown) {
  const entries = new Map();
  const lines = markdown.split(/\r?\n/);
  let heading = '';
  let provider = null;
  let sectionCapabilities = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,5})\s+(.+)$/);
    if (headingMatch) {
      heading = stripMarkdown(headingMatch[2]);
      if (headingMatch[1].length === 2) {
        provider = inferProviderFromHeading(heading);
      }
      sectionCapabilities = inferCapabilities(heading);
      continue;
    }

    if (!line.trim().startsWith('|')) continue;

    const cells = splitMarkdownRow(line);
    if (cells.length < 2 || isSeparatorRow(cells)) continue;

    const firstCell = cells[0];
    if (/^model(?:\s+id)?$/i.test(stripMarkdown(firstCell))) continue;

    const aliases = extractModelAliases(firstCell);
    if (!aliases.length) continue;

    const rowText = `${heading} ${cells.join(' ')}`;
    const capabilities = new Set([...sectionCapabilities, ...inferCapabilities(rowText)]);

    for (const alias of aliases) {
      addEntry(entries, alias, {
        provider,
        capabilities,
        sourceId: source.id,
      });
    }
  }

  return entries;
}

function mergeEntryMaps(maps) {
  const merged = new Map();

  for (const map of maps) {
    for (const [key, entry] of map) {
      const existing = merged.get(key) || {
        modelName: entry.modelName,
        aliases: new Set(),
        provider: entry.provider,
        capabilities: new Set(),
        sources: new Set(),
      };

      for (const alias of entry.aliases) existing.aliases.add(alias);
      for (const tag of entry.capabilities) existing.capabilities.add(tag);
      for (const source of entry.sources) existing.sources.add(source);
      if (!existing.provider && entry.provider) existing.provider = entry.provider;
      merged.set(key, existing);
    }
  }

  return merged;
}

function buildCatalog(sourceResults, options = {}) {
  const merged = mergeEntryMaps(sourceResults.map((result) => result.entries));
  const models = {};

  for (const [key, entry] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const capabilities = [...entry.capabilities].filter((tag) => CAPABILITY_TAGS.some((known) => known.id === tag)).sort();
    if (!capabilities.length) continue;

    models[key] = {
      modelName: entry.modelName,
      aliases: [...entry.aliases].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      provider: entry.provider,
      capabilities,
      sources: [...entry.sources].sort(),
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: (options.now || new Date()).toISOString(),
    tags: CAPABILITY_TAGS,
    sources: sourceResults.map((result) => ({
      id: result.source.id,
      name: result.source.name,
      url: result.source.url,
      bytes: result.markdown.length,
      models: result.entries.size,
    })),
    modelCount: Object.keys(models).length,
    models,
  };
}

async function generateCapabilityCatalog(options = {}) {
  const sourceResults = [];
  const sources = options.sources || DOC_SOURCES;

  for (const source of sources) {
    const markdown = options.markdowns && options.markdowns[source.id] !== undefined
      ? options.markdowns[source.id]
      : await fetchText(source.url, options);

    sourceResults.push({
      source,
      markdown,
      entries: parseMarkdownSource(source, markdown),
    });
  }

  return buildCatalog(sourceResults, options);
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempFile, filePath);
}

function withoutGeneratedAt(value) {
  return Object.assign({}, value, { generatedAt: null });
}

async function preserveGeneratedAtIfUnchanged(filePath, catalog) {
  try {
    const existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (JSON.stringify(withoutGeneratedAt(existing)) === JSON.stringify(withoutGeneratedAt(catalog))) {
      catalog.generatedAt = existing.generatedAt;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
  return catalog;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error('--timeout-ms must be a positive number');
  }

  const outputFile = options.outputFile || DEFAULT_OUTPUT_FILE;
  const catalog = await preserveGeneratedAtIfUnchanged(outputFile, await generateCapabilityCatalog(options));
  await writeJsonAtomic(outputFile, catalog);
  console.log(`wrote ${catalog.modelCount} model capability entries to ${outputFile}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

export {
  DOC_SOURCES,
  CAPABILITY_TAGS,
  stripMarkdown,
  normalizeModelKey,
  inferCapabilities,
  extractModelAliases,
  parseMarkdownSource,
  mergeEntryMaps,
  buildCatalog,
  generateCapabilityCatalog,
  preserveGeneratedAtIfUnchanged,
};
