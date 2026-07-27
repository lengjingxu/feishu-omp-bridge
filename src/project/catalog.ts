import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { getProjectRoots, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import type { Project } from './types';

export interface ProjectCatalog {
  list(): Promise<Project[]>;
  get(projectKey: string): Promise<Project | undefined>;
}

export class LocalProjectCatalog implements ProjectCatalog {
  private readonly cfg: AppConfig;
  private readonly hostId: string;

  constructor(cfg: AppConfig, hostId = 'local') {
    this.cfg = cfg;
    this.hostId = hostId;
  }

  async list(): Promise<Project[]> {
    const roots = getProjectRoots(this.cfg);
    const projects: Project[] = [];
    for (const root of roots) {
      const project = await this.fromRoot(root);
      if (project) projects.push(project);
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async get(projectKey: string): Promise<Project | undefined> {
    return (await this.list()).find((project) => project.projectKey === projectKey);
  }

  private async fromRoot(rawRoot: string): Promise<Project | undefined> {
    try {
      const cwd = await realpath(resolve(rawRoot));
      const info = await stat(cwd);
      if (!info.isDirectory()) return undefined;
      return {
        projectKey: `${this.hostId}::${cwd}`,
        name: basename(cwd) || cwd,
        cwd,
        hostId: this.hostId,
      };
    } catch (err) {
      log.warn('project', 'root-unavailable', { root: rawRoot, err: String(err) });
      return undefined;
    }
  }
}
