import React, { useState } from 'react';

type Language = 'en' | 'zh';

interface ToolCell {
  name: string;
  summary: string;
  detail: string;
}

interface Row {
  category: string;
  codex: ToolCell;
  claw: ToolCell;
}

const dataByLanguage: Record<Language, Row[]> = {
  en: [
    {
      category: 'File Search',
      codex: { name: 'shell + rg', summary: 'Shell-native search', detail: 'Codex leans on shell-native search while approval and sandbox policy govern execution.' },
      claw: { name: 'glob_search + grep_search', summary: 'Bounded named search tools', detail: 'Claw exposes structured discovery and text search tools with predictable output.' },
    },
    {
      category: 'File Editing',
      codex: { name: 'apply_patch', summary: 'Patch parser and orchestration', detail: 'Codex computes touched paths, routes edits through approval/sandbox orchestration, and applies patch operations.' },
      claw: { name: 'write_file + edit_file', summary: 'Whole-file and exact replacement', detail: 'Claw checks workspace boundaries, file size, binary content, and exact replacement semantics.' },
    },
    {
      category: 'Shell Execution',
      codex: { name: 'shell', summary: 'Sandbox-aware command runner', detail: 'Codex routes command execution through approval, sandbox selection, network policy, hooks, and retry paths.' },
      claw: { name: 'bash / PowerShell', summary: 'Permission-classified runner', detail: 'Claw classifies commands against permission modes before execution.' },
    },
    {
      category: 'Extensions',
      codex: { name: 'MCP, plugins, skills', summary: 'Tools and context extension surfaces', detail: 'Codex exposes external capabilities while preserving tool registry and approval boundaries.' },
      claw: { name: 'plugins, MCP, skills', summary: 'Runtime extension paths', detail: 'Claw feeds plugin, MCP, and skill definitions into prompts and tools.' },
    },
    {
      category: 'Multi-Agent',
      codex: { name: 'spawn_agent', summary: 'Child agents with fork modes', detail: 'Codex tracks child agents, supports context inheritance, and communicates through inter-agent messages.' },
      claw: { name: 'Agent tool', summary: 'Delegated jobs with fresh context', detail: 'Claw builds a fresh runtime for delegated jobs and returns results to the parent conversation.' },
    },
    {
      category: 'Permissions',
      codex: { name: 'approval orchestrator', summary: 'Approval, sandbox, hooks, retry', detail: 'Codex computes approval requirements, selects sandboxing, and can retry with broader permissions after approval.' },
      claw: { name: 'PermissionPolicy', summary: 'Mode and rule based authorization', detail: 'Claw combines permission mode, rules, hooks, tool requirements, and optional prompting.' },
    },
  ],
  zh: [
    {
      category: '文件搜索',
      codex: { name: 'shell + rg', summary: 'shell 原生搜索', detail: 'Codex 更依赖 shell 原生搜索，同时由审批和沙箱策略控制执行。' },
      claw: { name: 'glob_search + grep_search', summary: '有边界的具名搜索工具', detail: 'Claw 暴露结构化文件发现和文本搜索工具，输出更可预测。' },
    },
    {
      category: '文件编辑',
      codex: { name: 'apply_patch', summary: '补丁解析与编排', detail: 'Codex 计算受影响路径，并经过审批、沙箱和编排流程应用补丁操作。' },
      claw: { name: 'write_file + edit_file', summary: '整文件与精确替换', detail: 'Claw 检查工作区边界、文件大小、二进制内容，并使用精确替换语义。' },
    },
    {
      category: 'Shell 执行',
      codex: { name: 'shell', summary: '感知沙箱的命令执行器', detail: 'Codex 把命令执行接入审批、沙箱选择、网络策略、hooks 和重试路径。' },
      claw: { name: 'bash / PowerShell', summary: '带权限分类的命令执行器', detail: 'Claw 在执行前根据权限模式对命令分类。' },
    },
    {
      category: '扩展',
      codex: { name: 'MCP, plugins, skills', summary: '工具和上下文扩展面', detail: 'Codex 暴露外部能力，同时保留工具注册和审批边界。' },
      claw: { name: 'plugins, MCP, skills', summary: '运行时扩展路径', detail: 'Claw 将插件、MCP 和 Skill 定义送入提示和工具系统。' },
    },
    {
      category: '多 Agent',
      codex: { name: 'spawn_agent', summary: '支持 fork 模式的子 Agent', detail: 'Codex 跟踪子 Agent，支持上下文继承，并通过 Agent 间消息通信。' },
      claw: { name: 'Agent tool', summary: '带新上下文的委派任务', detail: 'Claw 为委派任务构建新的运行时，并把结果返回父会话。' },
    },
    {
      category: '权限',
      codex: { name: 'approval orchestrator', summary: '审批、沙箱、hooks 与重试', detail: 'Codex 计算审批需求、选择沙箱，并可能在授权后用更宽权限重试。' },
      claw: { name: 'PermissionPolicy', summary: '基于模式和规则的授权', detail: 'Claw 结合权限模式、规则、hooks、工具要求和可选提示。' },
    },
  ],
};

const copy = {
  en: {
    title: 'Capability Map',
    subtitle: 'A compact comparison of where each runtime places key responsibilities.',
    capability: 'Capability',
  },
  zh: {
    title: '能力地图',
    subtitle: '简洁对比两个运行时如何放置关键职责。',
    capability: '能力',
  },
} satisfies Record<Language, {
  title: string;
  subtitle: string;
  capability: string;
}>;

export default function ToolMatrix({ language = 'en' }: { language?: Language }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const data = dataByLanguage[language];
  const text = copy[language];

  function toggle(key: string) {
    setExpanded(expanded === key ? null : key);
  }

  return (
    <>
      <style>{styles}</style>
      <section className="matrix-section">
        <div className="section-header">
          <span className="eyebrow">TOOLS</span>
          <h2 className="section-heading">{text.title}</h2>
          <p className="section-subtitle">{text.subtitle}</p>
        </div>

        <div className="matrix-frame">
          <table className="tool-matrix">
            <thead>
              <tr>
                <th>{text.capability}</th>
                <th>Codex CLI</th>
                <th>Claw Code</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const codexKey = `${row.category}-codex`;
                const clawKey = `${row.category}-claw`;
                const isCodexExpanded = expanded === codexKey;
                const isClawExpanded = expanded === clawKey;
                return (
                  <React.Fragment key={row.category}>
                    <tr>
                      <td className="capability-cell">{row.category}</td>
                      <Cell cell={row.codex} cellKey={codexKey} expanded={expanded} toggle={toggle} />
                      <Cell cell={row.claw} cellKey={clawKey} expanded={expanded} toggle={toggle} />
                    </tr>
                    {(isCodexExpanded || isClawExpanded) && (
                      <tr className="detail-row">
                        <td colSpan={3}>{isCodexExpanded ? row.codex.detail : row.claw.detail}</td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Cell({
  cell,
  cellKey,
  expanded,
  toggle,
}: {
  cell: ToolCell;
  cellKey: string;
  expanded: string | null;
  toggle: (key: string) => void;
}) {
  const isExpanded = expanded === cellKey;
  return (
    <td>
      <button className={`matrix-cell ${isExpanded ? 'active' : ''}`} onClick={() => toggle(cellKey)}>
        <strong>{cell.name}</strong>
        <span>{cell.summary}</span>
      </button>
    </td>
  );
}

const styles = `
.matrix-section {
  padding: 56px 0;
}

.matrix-frame {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(16, 20, 19, 0.72);
}

.tool-matrix {
  min-width: 760px;
  margin: 0;
  border: 0;
}

.tool-matrix th,
.tool-matrix td {
  border-color: var(--border);
}

.tool-matrix th {
  padding: 12px 14px;
}

.tool-matrix td {
  padding: 0;
  vertical-align: stretch;
}

.capability-cell {
  width: 22%;
  padding: 16px !important;
  color: var(--text);
  font-weight: 700;
}

.matrix-cell {
  display: grid;
  width: 100%;
  min-height: 88px;
  padding: 14px;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.matrix-cell strong {
  color: var(--accent-bright);
  font-size: 0.86rem;
}

.matrix-cell span {
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 0.8rem;
  line-height: 1.45;
}

.matrix-cell:hover,
.matrix-cell.active {
  background: rgba(16, 185, 129, 0.085);
}

.detail-row td {
  padding: 14px 16px !important;
  background: rgba(16, 185, 129, 0.055);
  color: var(--text-secondary);
  font-size: 0.88rem;
  line-height: 1.65;
}
`;
