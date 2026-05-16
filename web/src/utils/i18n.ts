import type { Language } from '../content/chapters';

function normalizedBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

export function assetHref(base: string, assetPath: string) {
  return `${normalizedBase(base)}${assetPath.replace(/^\/+/, '')}`;
}

export function localizedHomeHref(base: string, language: Language) {
  return `${normalizedBase(base)}${language === 'zh' ? 'zh/' : ''}`;
}

export function localizedChapterHref(base: string, language: Language, slug: string) {
  return `${normalizedBase(base)}${language === 'zh' ? 'zh/' : ''}chapters/${slug}/`;
}
