import test from 'node:test';
import * as implementation from './model.mjs';
import { cases } from './cases.mjs';

for (const [name, verify] of cases) test(name, () => verify(implementation));
