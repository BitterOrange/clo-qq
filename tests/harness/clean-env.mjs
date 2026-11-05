// An explicit environment for a helper child process. Built from an allowlist, so a provider key or proxy in the
// shell that runs the tests cannot reach it. Tests that need more add it through `extra`.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OS_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'TEMP', 'TMP'];

export function cleanChildEnv(extra = {}, parent = process.env) {
  const env = {};
  for (const k of OS_KEYS) {
    if (parent[k]) env[k] = parent[k];
  }
  const systemRoot = parent.SystemRoot ?? 'C:\\Windows';
  env.PATH = `${join(ROOT, '.runtime', 'node')};${join(systemRoot, 'System32')}`;
  env.NODE_NO_WARNINGS = '1';
  return { ...env, ...extra };
}
