import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('Orchestrator HealthController', () => {
  it('reports ok for the orchestrator service', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    const result = moduleRef.get(HealthController).check();

    expect(result).toMatchObject({ status: 'ok', service: 'orchestrator' });
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
