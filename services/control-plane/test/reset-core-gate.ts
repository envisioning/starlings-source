import { beforeEach } from 'vitest';
import { resetCoreGate } from '../src/core-gate';

// The gate's memo and cooldown live in the isolate; each case starts cold.
beforeEach(() => resetCoreGate());
