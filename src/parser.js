const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// API-equivalent pricing per token (informational only — not subscription cost)
const MODEL_PRICING = {
  'opus-4.5': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.50 / 1e6 },
  'opus-4.6': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.50 / 1e6 },
  'opus-4.0': { input: 15 / 1e6, output: 75 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.50 / 1e6 },
  'opus-4.1': { input: 15 / 1e6, output: 75 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.50 / 1e6 },
  'sonnet': { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.30 / 1e6 },
  'haiku-4.5': { input: 1 / 1e6, output: 5 / 1e6, cacheWrite: 1.25 / 1e6, cacheRead: 0.10 / 1e6 },
  'haiku-3.5': { input: 0.80 / 1e6, output: 4 / 1e6, cacheWrite: 1.00 / 1e6, cacheRead: 0.08 / 1e6 },
};

function getPricing(model) {
  if (!model) return MODEL_PRICING.sonnet;
  const m = model.toLowerCase();
  if (m.includes('opus')) {
    if (m.includes('4-6') || m.includes('4.6')) return MODEL_PRICING['opus-4.6'];
    if (m.includes('4-5') || m.includes('4.5')) return MODEL_PRICING['opus-4.5'];
    if (m.includes('4-1') || m.includes('4.1')) return MODEL_PRICING['opus-4.1'];
    return MODEL_PRICING['opus-4.0'];
  }
  if (m.includes('sonnet')) return MODEL_PRICING.sonnet;
  if (m.includes('haiku')) {
    if (m.includes('4-5') || m.includes('4.5')) return MODEL_PRICING['haiku-4.5'];
    return MODEL_PRICING['haiku-3.5'];
  }
  return MODEL_PRICING.sonnet;
}

function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function getCachePath() {
  return path.join(getClaudeDir(), 'pulse-cache.json');
}

function loadCache() {
  try {
    const data = fs.readFileSync(getCachePath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(getCachePath(), JSON.stringify(cache));
  } catch {
    // Non-critical — skip silently
  }
}

function getCacheKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

async function parseJSONLFile(filePath) {
  // Deduplicate by message.id — last-write-wins
  // Streaming produces multiple entries per message; the last has final usage counts
  const messageMap = new Map();
  const userMessages = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    // Skip non-message types and sidechains
    if (entry.isSidechain) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (entry.type === 'user' && msg.role === 'user') {
      userMessages.push(entry);
    }

    if (entry.type === 'assistant' && msg.id) {
      // Last-write-wins: later entries for same message.id overwrite earlier ones
      messageMap.set(msg.id, entry);
    }
  }

  return { assistantEntries: [...messageMap.values()], userMessages };
}

function extractSessionData(assistantEntries, userMessages) {
  const queries = [];

  // Build a timeline of user messages for pairing
  const userTimeline = userMessages
    .filter(e => {
      if (e.isMeta) return false;
      const content = e.message?.content;
      if (typeof content === 'string' && (
        content.startsWith('<local-command') ||
        content.startsWith('<command-name')
      )) return false;
      return true;
    })
    .map(e => {
      const content = e.message.content;
      const text = typeof content === 'string'
        ? content
        : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { text: text || null, timestamp: e.timestamp, uuid: e.uuid };
    });

  let userIdx = 0;

  for (const entry of assistantEntries) {
    const msg = entry.message;
    const usage = msg.usage;
    if (!usage) continue;

    const model = msg.model || 'unknown';
    if (model === '<synthetic>') continue;

    // Find the most recent user message before this assistant response
    while (userIdx < userTimeline.length - 1 &&
      userTimeline[userIdx + 1].timestamp <= entry.timestamp) {
      userIdx++;
    }
    const userMsg = userTimeline[userIdx] || null;

    const pricing = getPricing(model);
    const inputTokens = usage.input_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;

    const cost = (inputTokens * pricing.input)
      + (cacheCreationTokens * pricing.cacheWrite)
      + (cacheReadTokens * pricing.cacheRead)
      + (outputTokens * pricing.output);

    const tools = [];
    let hasThinking = false;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name) tools.push(block.name);
        if (block.type === 'thinking') hasThinking = true;
      }
    }

    queries.push({
      messageId: msg.id,
      userPrompt: userMsg?.text || null,
      userTimestamp: userMsg?.timestamp || null,
      assistantTimestamp: entry.timestamp,
      model,
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      cost,
      tools,
      hasThinking,
    });
  }

  return queries;
}

async function parseAllSessions(forceRefresh = false) {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return emptyResult();
  }

  const cache = forceRefresh ? {} : loadCache();
  const newCache = {};

  // Read history.jsonl for display text
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const sessionFirstPrompt = {};
  if (fs.existsSync(historyPath)) {
    const stream = fs.createReadStream(historyPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
          const display = entry.display.trim();
          if (display.startsWith('/') && display.length < 30) continue;
          sessionFirstPrompt[entry.sessionId] = display;
        }
      } catch { /* skip */ }
    }
  }

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir).filter(d => {
      try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); }
      catch { return false; }
    });
  } catch {
    return emptyResult();
  }

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];
  const toolFrequency = {};

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, '.jsonl');
      const cacheKey = getCacheKey(filePath);

      let queries;
      if (cacheKey && cache[cacheKey]) {
        queries = cache[cacheKey];
        if (cacheKey) newCache[cacheKey] = queries;
      } else {
        let parsed;
        try {
          parsed = await parseJSONLFile(filePath);
        } catch { continue; }

        if (parsed.assistantEntries.length === 0) continue;
        queries = extractSessionData(parsed.assistantEntries, parsed.userMessages);
        if (cacheKey) newCache[cacheKey] = queries;
      }

      if (!queries || queries.length === 0) continue;

      // Aggregate session
      let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, cost = 0;
      let thinkingTurns = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
        cacheCreationTokens += q.cacheCreationTokens;
        cacheReadTokens += q.cacheReadTokens;
        cost += q.cost;
        if (q.hasThinking) thinkingTurns++;
        for (const tool of q.tools) {
          toolFrequency[tool] = (toolFrequency[tool] || 0) + 1;
        }
      }
      const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;

      const firstTimestamp = queries.find(q => q.assistantTimestamp)?.assistantTimestamp
        || queries.find(q => q.userTimestamp)?.userTimestamp;
      const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

      // Primary model
      const modelCounts = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

      const firstPrompt = sessionFirstPrompt[sessionId]
        || queries.find(q => q.userPrompt)?.userPrompt
        || '(no prompt)';

      // Per-prompt grouping for expensive prompts
      let currentPrompt = null;
      let pInput = 0, pOutput = 0, pCacheCreate = 0, pCacheRead = 0, pCost = 0;
      const flushPrompt = () => {
        if (currentPrompt && (pInput + pOutput + pCacheCreate + pCacheRead) > 0) {
          allPrompts.push({
            prompt: currentPrompt.substring(0, 300),
            inputTokens: pInput, outputTokens: pOutput,
            cacheCreationTokens: pCacheCreate, cacheReadTokens: pCacheRead,
            totalTokens: pInput + pOutput + pCacheCreate + pCacheRead,
            cost: pCost, date, sessionId, model: primaryModel,
          });
        }
      };
      for (const q of queries) {
        if (q.userPrompt && q.userPrompt !== currentPrompt) {
          flushPrompt();
          currentPrompt = q.userPrompt;
          pInput = 0; pOutput = 0; pCacheCreate = 0; pCacheRead = 0; pCost = 0;
        }
        pInput += q.inputTokens;
        pOutput += q.outputTokens;
        pCacheCreate += q.cacheCreationTokens;
        pCacheRead += q.cacheReadTokens;
        pCost += q.cost;
      }
      flushPrompt();

      const totalToolCalls = queries.reduce((sum, q) => sum + q.tools.length, 0);
      const sessionTools = queries.flatMap(q => q.tools);

      sessions.push({
        sessionId, project: projectDir, date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
        totalTokens, cost,
        thinkingTurns,
        totalToolCalls,
        toolDensity: queries.length > 0 ? totalToolCalls / queries.length : 0,
        tools: sessionTools,
      });

      // Daily aggregation
      if (date !== 'unknown') {
        if (!dailyMap[date]) {
          dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, cost: 0, sessions: 0, queries: 0 };
        }
        const d = dailyMap[date];
        d.inputTokens += inputTokens;
        d.outputTokens += outputTokens;
        d.cacheCreationTokens += cacheCreationTokens;
        d.cacheReadTokens += cacheReadTokens;
        d.totalTokens += totalTokens;
        d.cost += cost;
        d.sessions += 1;
        d.queries += queries.length;
      }

      // Model aggregation
      for (const q of queries) {
        if (q.model === '<synthetic>' || q.model === 'unknown') continue;
        if (!modelMap[q.model]) {
          modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, cost: 0, queryCount: 0 };
        }
        const mm = modelMap[q.model];
        mm.inputTokens += q.inputTokens;
        mm.outputTokens += q.outputTokens;
        mm.cacheCreationTokens += q.cacheCreationTokens;
        mm.cacheReadTokens += q.cacheReadTokens;
        mm.totalTokens += q.totalTokens;
        mm.cost += q.cost;
        mm.queryCount += 1;
      }
    }
  }

  saveCache(newCache);

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const modelBreakdown = Object.values(modelMap).sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 50);

  // Project aggregation
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project;
    if (!projectMap[proj]) {
      projectMap[proj] = { project: proj, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, cost: 0, sessionCount: 0, queryCount: 0 };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.cacheCreationTokens += session.cacheCreationTokens;
    p.cacheReadTokens += session.cacheReadTokens;
    p.totalTokens += session.totalTokens;
    p.cost += session.cost;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;
  }
  const projects = Object.values(projectMap).sort((a, b) => b.totalTokens - a.totalTokens);

  // Totals
  const totalInput = sessions.reduce((s, x) => s + x.inputTokens, 0);
  const totalOutput = sessions.reduce((s, x) => s + x.outputTokens, 0);
  const totalCacheCreation = sessions.reduce((s, x) => s + x.cacheCreationTokens, 0);
  const totalCacheRead = sessions.reduce((s, x) => s + x.cacheReadTokens, 0);
  const totalTokens = totalInput + totalOutput + totalCacheCreation + totalCacheRead;
  const totalCost = sessions.reduce((s, x) => s + x.cost, 0);
  const totalQueries = sessions.reduce((s, x) => s + x.queryCount, 0);
  const totalThinkingTurns = sessions.reduce((s, x) => s + x.thinkingTurns, 0);
  const cacheHitRate = (totalCacheRead + totalCacheCreation) > 0
    ? totalCacheRead / (totalCacheRead + totalCacheCreation + totalInput)
    : 0;

  // Tool frequency sorted
  const toolStats = Object.entries(toolFrequency)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts,
    projects,
    toolStats,
    totals: {
      totalTokens, totalInput, totalOutput, totalCacheCreation, totalCacheRead,
      totalCost, totalSessions: sessions.length, totalQueries,
      totalThinkingTurns, cacheHitRate,
      avgTokensPerSession: sessions.length > 0 ? Math.round(totalTokens / sessions.length) : 0,
      avgTokensPerQuery: totalQueries > 0 ? Math.round(totalTokens / totalQueries) : 0,
    },
  };
}

function emptyResult() {
  return {
    sessions: [], dailyUsage: [], modelBreakdown: [], topPrompts: [],
    projects: [], toolStats: [],
    totals: {
      totalTokens: 0, totalInput: 0, totalOutput: 0, totalCacheCreation: 0,
      totalCacheRead: 0, totalCost: 0, totalSessions: 0, totalQueries: 0,
      totalThinkingTurns: 0, cacheHitRate: 0, avgTokensPerSession: 0, avgTokensPerQuery: 0,
    },
  };
}

module.exports = { parseAllSessions, getPricing };
