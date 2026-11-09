import type { Skill } from '@earendil-works/pi-coding-agent'

export interface SkillSearchPage {
  total: number
  offset: number
  next_offset: number | null
  has_more: boolean
  skills: Array<{ name: string; description: string; path: string }>
}

export function searchAuthorizedSkills(
  skills: readonly Skill[],
  query = '',
  offset = 0
): SkillSearchPage {
  const normalizedQuery = query.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  const matches = skills.filter(
    (skill) =>
      !normalizedQuery ||
      `${skill.name} ${skill.description}`
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .includes(normalizedQuery)
  )
  const page = matches.slice(offset, offset + 10).map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.filePath
  }))
  const nextOffset = offset + page.length < matches.length ? offset + page.length : null
  return {
    total: matches.length,
    offset,
    next_offset: nextOffset,
    has_more: nextOffset !== null,
    skills: page
  }
}
