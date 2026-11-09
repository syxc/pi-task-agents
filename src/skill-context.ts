import { dirname, isAbsolute, normalize, relative } from 'node:path'
import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent'

export const compactSkillCatalogHeader = 'Skill metadata (pi-task-agents):'

type CatalogRow = [name: string, description: string, root: number | null, path: string]

/** Preserve every advertised field while sharing repeated directory prefixes. */
export function compactSkillCatalog(
  skills: readonly Skill[],
  reader: 'read' | 'bash' | 'indirect'
): string | undefined {
  const visible = skills.filter((skill) => !skill.disableModelInvocation)
  if (visible.length === 0) {
    return
  }
  const roots: string[] = []
  const rows: CatalogRow[] = visible.map((skill) => {
    if (!isAbsolute(skill.filePath) || normalize(skill.filePath) !== skill.filePath) {
      return [skill.name, skill.description, null, skill.filePath]
    }
    const root = dirname(dirname(skill.filePath))
    let index = roots.indexOf(root)
    if (index < 0) {
      index = roots.length
      roots.push(root)
    }
    return [skill.name, skill.description, index, relative(root, skill.filePath)]
  })
  // JSON escapes prevent metadata from closing the surrounding prompt section.
  const json = JSON.stringify({ roots, skills: rows }).replace(/[<>&]/gu, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  const text = [
    compactSkillCatalogHeader,
    'The following skills provide specialized instructions for specific tasks.',
    reader === 'indirect'
      ? "Load a skill's file when the task matches its description."
      : `Use ${reader} to load a skill's file when the task matches its description.`,
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    'Catalog JSON rows are [name, complete description, zero-based root index, file path]. Join roots[index] and file path; a null index means the path is already exact.',
    json
  ].join('\n')
  return text.length < formatSkillsForPrompt([...skills], reader).trim().length ? text : undefined
}

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
