import { existsSync } from "node:fs";
import path from "node:path";

export interface RuntimeRootContext {
  readonly isPackaged: boolean;
  readonly cwd: string;
  readonly execPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function resolveRuntimeRoot(context: RuntimeRootContext): string {
  const explicitRoot = context.environment.LIVE_TRANSLATING_DATA_DIR?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);

  const portableDirectory = context.environment.PORTABLE_EXECUTABLE_DIR?.trim();
  if (portableDirectory) {
    const projectRoot = path.dirname(portableDirectory);
    if (
      existsSync(path.join(projectRoot, "package.json"))
      && existsSync(path.join(projectRoot, "src"))
    ) {
      return projectRoot;
    }
    return path.resolve(portableDirectory);
  }
  return context.isPackaged ? path.dirname(context.execPath) : context.cwd;
}
