import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalProjectCatalog } from './catalog';
import type { AppConfig } from '../config/schema';

function cfg(projectRoots: string[]): AppConfig {
  return { accounts: { app: { id: 'cli_x', secret: 'secret', tenant: 'feishu' } }, preferences: { projectRoots } };
}

describe('LocalProjectCatalog', () => {
  it('normalizes configured directories into stable projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-project-catalog-'));
    const nested = join(root, 'demo');
    await mkdir(nested);
    const projects = await new LocalProjectCatalog(cfg([`${nested}/.`])).list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe('demo');
    expect(projects[0]?.projectKey).toBe(`local::${await realpath(nested)}`);
  });

  it('merges project directories discovered from Codex history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-project-history-'));
    const nested = join(root, 'history-project');
    await mkdir(nested);
    const projects = await new LocalProjectCatalog(cfg([]), 'local', async () => [nested, nested]).list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.cwd).toBe(await realpath(nested));
  });
});
