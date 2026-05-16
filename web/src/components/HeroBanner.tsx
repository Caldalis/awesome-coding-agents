import { useEffect, useRef, useState } from 'react';

type Language = 'en' | 'zh';

interface StatItem {
  value: number;
  suffix: string;
  label: string;
}

function AnimatedNumber({ target, suffix = '' }: { target: number; suffix?: string }) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const duration = 900;
    const start = performance.now();

    function step(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }, [target]);

  return <span ref={ref}>{value}{suffix}</span>;
}

const copy = {
  en: {
    eyebrow: 'SOURCE GUIDE',
    title: 'The Grammar of Autonomous Code',
    subtitle: 'A source-level study of how coding agents perceive, decide, act, and verify.',
    cta: 'Read chapters',
    secondary: 'Compare Codex and Claw Code（Claude Code）',
    codexMeta: 'OpenAI · Rust · sandbox-first',
    clawMeta: 'Rust · Claude-style · permission-first',
    stats: [
      { value: 12, suffix: '', label: 'chapters' },
      { value: 2, suffix: '', label: 'deep dives' },
      { value: 30, suffix: '', label: 'pages' },
    ],
  },
  zh: {
    eyebrow: 'SOURCE GUIDE',
    title: 'The Grammar of Autonomous Code',
    subtitle: '一项关于编码代理如何感知、决策、行动和验证的源级研究',
    cta: '阅读章节',
    secondary: '对比 Codex 与 Claw Code（Claude Code）',
    codexMeta: 'OpenAI · Rust · 沙箱优先',
    clawMeta: 'Rust · Claude 风格 · 权限优先',
    stats: [
      { value: 12, suffix: '', label: '章节' },
      { value: 2, suffix: '', label: '深入文章' },
      { value: 30, suffix: '', label: '页面' },
    ],
  },
} satisfies Record<Language, {
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  secondary: string;
  codexMeta: string;
  clawMeta: string;
  stats: StatItem[];
}>;

export default function HeroBanner({ language = 'en' }: { language?: Language }) {
  const text = copy[language];

  return (
    <>
      <style>{styles}</style>
      <section className="hero">
        <div className="hero-main">
          <span className="eyebrow">{text.eyebrow}</span>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
          <div className="hero-actions">
            <a className="primary-action" href="#chapters">{text.cta}</a>
            <span className="secondary-copy">{text.secondary}</span>
          </div>
        </div>

        <aside className="hero-aside" aria-label="Project summary">
          <div className="agent-line">
            <span>Codex CLI</span>
            <small>{text.codexMeta}</small>
          </div>
          <div className="agent-line blue">
            <span>Claw Code</span>
            <small>{text.clawMeta}</small>
          </div>
          <div className="stat-row">
            {text.stats.map((stat) => (
              <div className="stat" key={stat.label}>
                <strong><AnimatedNumber target={stat.value} suffix={stat.suffix} /></strong>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>
    </>
  );
}

const styles = `
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);
  gap: 28px;
  align-items: center;
  padding: 72px 0 42px;
}

.hero-main h1 {
  max-width: 840px;
  margin: 14px 0 18px;
  color: var(--text);
  font-size: clamp(2.2rem, 6vw, 5rem);
  font-weight: 700;
  line-height: 1.04;
}

.hero-main p {
  max-width: 720px;
  color: var(--text-secondary);
  font-size: clamp(1rem, 1.5vw, 1.12rem);
}

.hero-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 28px;
}

.primary-action {
  display: inline-flex;
  align-items: center;
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid var(--border-green);
  border-radius: 8px;
  background: rgba(16, 185, 129, 0.12);
  color: var(--accent-bright);
  font-size: 0.86rem;
  font-weight: 700;
  box-shadow: var(--glow-soft);
}

.primary-action:hover {
  background: rgba(16, 185, 129, 0.18);
  color: var(--accent-bright);
}

.secondary-copy {
  color: var(--text-muted);
  font-size: 0.86rem;
}

.hero-aside {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(16, 20, 19, 0.76);
}

.agent-line {
  padding: 13px 14px;
  border: 1px solid var(--border-green);
  border-radius: 9px;
  background: rgba(16, 185, 129, 0.07);
}

.agent-line.blue {
  border-color: rgba(56, 189, 248, 0.26);
  background: rgba(56, 189, 248, 0.055);
}

.agent-line span {
  display: block;
  color: var(--text);
  font-weight: 700;
}

.agent-line small {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 0.76rem;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 4px;
}

.stat {
  padding: 10px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  text-align: center;
  background: rgba(255, 255, 255, 0.02);
}

.stat strong {
  display: block;
  color: var(--accent-bright);
  font-size: 1.25rem;
  line-height: 1.2;
}

.stat span {
  color: var(--text-muted);
  font-size: 0.72rem;
}

@media (max-width: 860px) {
  .hero {
    grid-template-columns: 1fr;
    padding-top: 48px;
  }
}
`;
