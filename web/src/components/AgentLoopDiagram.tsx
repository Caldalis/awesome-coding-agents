import { useState } from 'react';

type Language = 'en' | 'zh';

interface Step {
  label: string;
  description: string;
}

const copy = {
  en: {
    title: 'Runtime Flow',
    subtitle: 'A compact view of how a user request becomes model events, tools, observations, and the next turn.',
    steps: [
      { label: 'Input', description: 'User message enters the session.' },
      { label: 'Context', description: 'Runtime builds prompt, memory, tool schemas, and policies.' },
      { label: 'Model', description: 'Provider stream returns text and tool-call events.' },
      { label: 'Tools', description: 'Runtime authorizes, executes, and records tool results.' },
      { label: 'Validate', description: 'Tests or builds provide evidence for the final answer.' },
      { label: 'Continue', description: 'The loop continues, compacts, or finalizes.' },
    ],
  },
  zh: {
    title: '运行时流程',
    subtitle: '简化展示一次用户请求如何变成模型事件、工具调用、观察结果和下一轮 turn。',
    steps: [
      { label: '输入', description: '用户消息进入会话。' },
      { label: '上下文', description: '运行时构造提示、记忆、工具 schema 和策略。' },
      { label: '模型', description: '供应商流返回文本和工具调用事件。' },
      { label: '工具', description: '运行时授权、执行并记录工具结果。' },
      { label: '验证', description: '测试或构建为最终回答提供证据。' },
      { label: '继续', description: '循环继续、压缩或最终结束。' },
    ],
  },
} satisfies Record<Language, {
  title: string;
  subtitle: string;
  steps: Step[];
}>;

export default function AgentLoopDiagram({ language = 'en' }: { language?: Language }) {
  const [active, setActive] = useState(0);
  const text = copy[language];

  return (
    <>
      <style>{styles}</style>
      <section className="flow-section">
        <div className="section-header">
          <span className="eyebrow">FLOW</span>
          <h2 className="section-heading">{text.title}</h2>
          <p className="section-subtitle">{text.subtitle}</p>
        </div>
        <div className="flow-strip">
          {text.steps.map((step, index) => (
            <button
              className={`flow-step ${active === index ? 'active' : ''}`}
              key={step.label}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => setActive(index)}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{step.label}</strong>
            </button>
          ))}
        </div>
        <p className="flow-detail">{text.steps[active].description}</p>
      </section>
    </>
  );
}

const styles = `
.flow-section {
  padding: 56px 0;
}

.section-header {
  max-width: 720px;
  margin-bottom: 24px;
}

.section-heading {
  margin: 8px 0 10px;
}

.flow-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(16, 20, 19, 0.72);
}

.flow-step {
  display: grid;
  gap: 8px;
  min-height: 86px;
  padding: 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.flow-step span {
  color: var(--text-muted);
  font-family: var(--font-pixel);
  font-size: 0.52rem;
}

.flow-step strong {
  color: inherit;
  font-size: 0.86rem;
}

.flow-step:hover,
.flow-step.active {
  border-color: var(--border-green);
  background: rgba(16, 185, 129, 0.1);
  color: var(--accent-bright);
}

.flow-detail {
  min-height: 42px;
  margin-top: 14px;
  color: var(--text-secondary);
}

@media (max-width: 900px) {
  .flow-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .flow-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
`;
