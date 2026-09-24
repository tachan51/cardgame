// engine/scenarios/*.json のテストシナリオをすべて実行する（タスク 1-13）
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScenario, type Scenario } from '../src/scenario';
import { cat } from './helpers';

const DIR = join(import.meta.dirname, '..', 'scenarios');

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const { scenarios } = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { scenarios: Scenario[] };
  describe(file, () => {
    for (const sc of scenarios) {
      it(sc.name, () => {
        const r = runScenario(cat, sc);
        expect(r.errors).toEqual([]);
      });
    }
  });
}
