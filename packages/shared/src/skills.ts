import type {McpServer} from '@modelcontextprotocol/server';
import {
  memorySkillFiles,
  SkillCatalog,
} from '@modelcontextprotocol/server/ext/skills';
import {reportError} from './error-record.ts';
import type {ApplicationRole} from './platform.ts';

/** One task text an application offers as a skill. */
export interface TaskSkill {
  /** Lowercase words joined by hyphens; also the skill's folder. */
  name: string;
  /** What the skill is for and when a host reads it. */
  description: string;
  text: string;
}

/** The skill's one file: the frontmatter a host lists it by, then the text unchanged. */
export function skillFile({name, description, text}: TaskSkill): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${text}\n`;
}

function load(skills: readonly TaskSkill[]) {
  const files = Object.fromEntries(
    skills.map(skill => [`${skill.name}/SKILL.md`, skillFile(skill)]),
  );
  return SkillCatalog.load(memorySkillFiles(files), {strict: true});
}

/** Serves fixed task texts on an application's server through the MCP Skills extension.
 *  The catalog is built on first use and then kept. Skills are an addition: when they cannot
 *  be served, the failure is recorded and the server works without them. */
export function taskSkills(
  application: ApplicationRole,
  skills: readonly TaskSkill[],
) {
  let catalog: SkillCatalog | undefined;
  return async (server: McpServer): Promise<void> => {
    try {
      catalog ??= await load(skills);
      catalog.attach(server);
    } catch (error) {
      reportError(error, {
        tool: application,
        stage: 'skills',
        code: 'skills_unavailable',
      });
    }
  };
}
