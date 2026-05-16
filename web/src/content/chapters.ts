export type Language = 'en' | 'zh';

export interface Chapter {
  number: string;
  slug: string;
  title: string;
  description: string;
  docPath: string;
}

export interface DeepDive {
  slug: string;
  title: string;
  parentSlug: string;
  docPath: string;
}

const englishChapters: Chapter[] = [
  { number: '01', slug: 'overview', title: 'Overview: What Makes a Coding Agent', description: 'The runtime loop, core boundaries, and design space behind coding agents', docPath: '01-overview-what-makes-a-coding-agent/README.md' },
  { number: '02', slug: 'architecture', title: 'Runtime Architecture', description: 'How CLI, runtime, configuration, plugins, MCP, skills, and UI layers fit together', docPath: '02-runtime-architecture/README.md' },
  { number: '03', slug: 'agent-loop', title: 'Agent Loop and Turn Execution', description: 'How user input becomes model streams, tool calls, observations, validation, and follow-up turns', docPath: '03-agent-loop-turn-execution/README.md' },
  { number: '04', slug: 'tool-system', title: 'Tool System and Orchestration', description: 'How built-in, plugin, MCP, and skill tools are registered, authorized, and executed', docPath: '04-tool-system-orchestration/README.md' },
  { number: '05', slug: 'file-search', title: 'Code Search and Discovery', description: 'How agents locate files, search text, rank evidence, and narrow investigations', docPath: '05-code-search-discovery/README.md' },
  { number: '06', slug: 'file-editing', title: 'File Editing and Patch Application', description: 'Patch application, string replacement, whole-file writes, and edit safety', docPath: '06-file-editing-patch-application/README.md' },
  { number: '07', slug: 'sandbox-security', title: 'Sandboxing and Process Security', description: 'Platform containment, filesystem and network boundaries, and defense in depth', docPath: '07-sandboxing-process-security/README.md' },
  { number: '08', slug: 'permissions', title: 'Permissions and Approval Flow', description: 'Approval modes, command classification, hooks, denials, and user prompts', docPath: '08-permissions-approval-flow/README.md' },
  { number: '09', slug: 'context-management', title: 'Context, History, and Compaction', description: 'Conversation history, tool-pair integrity, token budgets, and compaction', docPath: '09-context-history-compaction/README.md' },
  { number: '10', slug: 'prompt-engineering', title: 'Prompt Construction and Project Memory', description: 'Base instructions, project memory, dynamic context, extensions, and cache-aware prompts', docPath: '10-prompt-construction-project-memory/README.md' },
  { number: '11', slug: 'model-integration', title: 'Model Clients, Streaming, and Caching', description: 'Provider adapters, streaming events, retries, usage tracking, and prompt caching', docPath: '11-model-clients-streaming-caching/README.md' },
  { number: '12', slug: 'multi-agent', title: 'Sub-Agents and Delegation', description: 'Agent spawning, context inheritance, messaging, roles, waiting, and cleanup', docPath: '12-sub-agents-delegation/README.md' },
];

const chineseChapters: Chapter[] = [
  { number: '01', slug: 'overview', title: '总览：什么构成一个编程 Agent', description: '理解 Agent 循环、核心边界，以及编程 Agent 的设计空间', docPath: 'zh/01-overview-what-makes-a-coding-agent/README.md' },
  { number: '02', slug: 'architecture', title: '运行时架构', description: 'CLI、运行时、配置、插件、MCP、Skills 与 UI 层如何协作', docPath: 'zh/02-runtime-architecture/README.md' },
  { number: '03', slug: 'agent-loop', title: 'Agent 循环与 Turn 执行', description: '用户输入如何变成模型流、工具调用、观察、验证和后续 turn', docPath: 'zh/03-agent-loop-turn-execution/README.md' },
  { number: '04', slug: 'tool-system', title: '工具系统与编排', description: '内置工具、插件、MCP 和 Skills 如何注册、授权与执行', docPath: 'zh/04-tool-system-orchestration/README.md' },
  { number: '05', slug: 'file-search', title: '代码搜索与发现', description: 'Agent 如何定位文件、搜索文本、排序证据并逐步缩小调查范围', docPath: 'zh/05-code-search-discovery/README.md' },
  { number: '06', slug: 'file-editing', title: '文件编辑与补丁应用', description: '补丁应用、精确替换、整文件写入和编辑安全', docPath: 'zh/06-file-editing-patch-application/README.md' },
  { number: '07', slug: 'sandbox-security', title: '沙箱与进程安全', description: '平台隔离、文件系统与网络边界，以及多层防御', docPath: 'zh/07-sandboxing-process-security/README.md' },
  { number: '08', slug: 'permissions', title: '权限与审批流程', description: '审批模式、命令分类、hooks、拒绝处理和用户确认', docPath: 'zh/08-permissions-approval-flow/README.md' },
  { number: '09', slug: 'context-management', title: '上下文、历史与压缩', description: '对话历史、工具配对、token 预算和压缩策略', docPath: 'zh/09-context-history-compaction/README.md' },
  { number: '10', slug: 'prompt-engineering', title: '提示构造与项目记忆', description: '基础指令、项目记忆、动态上下文、扩展和缓存友好提示', docPath: 'zh/10-prompt-construction-project-memory/README.md' },
  { number: '11', slug: 'model-integration', title: '模型客户端、流式事件与缓存', description: '供应商适配、流式事件、重试、用量统计和 prompt caching', docPath: 'zh/11-model-clients-streaming-caching/README.md' },
  { number: '12', slug: 'multi-agent', title: '子 Agent 与委派', description: 'Agent 创建、上下文继承、消息传递、角色、等待和清理', docPath: 'zh/12-sub-agents-delegation/README.md' },
];

const englishDeepDives: DeepDive[] = [
  { slug: 'agentic-execution', title: 'Agentic Execution Deep Dive', parentSlug: 'agent-loop', docPath: '03-agent-loop-turn-execution/agentic-execution.md' },
  { slug: 'extensions-deep-dive', title: 'Extensions Deep Dive', parentSlug: 'tool-system', docPath: '04-tool-system-orchestration/extensions-deep-dive.md' },
];

const chineseDeepDives: DeepDive[] = [
  { slug: 'agentic-execution', title: 'Agentic Execution 深入', parentSlug: 'agent-loop', docPath: 'zh/03-agent-loop-turn-execution/agentic-execution.md' },
  { slug: 'extensions-deep-dive', title: '扩展机制深入', parentSlug: 'tool-system', docPath: 'zh/04-tool-system-orchestration/extensions-deep-dive.md' },
];

export const chaptersByLanguage: Record<Language, Chapter[]> = {
  en: englishChapters,
  zh: chineseChapters,
};

export const deepDivesByLanguage: Record<Language, DeepDive[]> = {
  en: englishDeepDives,
  zh: chineseDeepDives,
};

export const siteCopy = {
  en: {
    htmlLang: 'en',
    siteTitle: 'Awesome Coding Agents',
    navBrand: 'Coding Agents',
    homeTitle: 'Home',
    chaptersHeading: 'Chapters',
    breadcrumbHome: 'Home',
    previous: 'Previous',
    next: 'Next',
    backToAgentLoop: 'Back to Agent Loop',
    backToToolSystem: 'Back to Tool System',
    deepDive: 'Deep Dive',
    extensionsDeepDive: 'Extensions Deep Dive',
    languageLabel: 'Language',
  },
  zh: {
    htmlLang: 'zh-CN',
    siteTitle: 'Awesome Coding Agents',
    navBrand: '编程 Agent',
    homeTitle: '首页',
    chaptersHeading: '章节',
    breadcrumbHome: '首页',
    previous: '上一章',
    next: '下一章',
    backToAgentLoop: '返回 Agent 循环',
    backToToolSystem: '返回工具系统',
    deepDive: '深入',
    extensionsDeepDive: '扩展机制深入',
    languageLabel: '语言',
  },
} as const;

export const chapters = englishChapters;
export const deepDives = englishDeepDives;

export function getChapters(language: Language = 'en') {
  return chaptersByLanguage[language];
}

export function getDeepDives(language: Language = 'en') {
  return deepDivesByLanguage[language];
}

export function getSiteCopy(language: Language = 'en') {
  return siteCopy[language];
}
