import assert from 'node:assert/strict';
import test from 'node:test';
import { queueStartControl } from '../../src/features/jobs/queueControls';
import { getKaggleAvailability } from '../../server/kaggle/availability';

test('first start and resume require a ready worker and queued work', () => {
  assert.equal(queueStartControl('IDLE', 1, false, true).disabled, false);
  assert.equal(queueStartControl('PAUSED', 1, false, true).label, 'Resume queue');
  for (const state of ['IDLE', 'PAUSED'] as const) {
    assert.equal(queueStartControl(state, 1, false, false).disabled, true);
    assert.equal(queueStartControl(state, 0, false, true).disabled, true);
    assert.equal(queueStartControl(state, 1, true, true).disabled, true);
  }
});

test('running and stopping queues cannot start a duplicate run', () => {
  assert.equal(queueStartControl('RUNNING', 4, false, true).disabled, true);
  assert.equal(queueStartControl('PAUSING', 4, false, true).disabled, true);
});

test('pre-worker availability never claims that configuration enables processing', () => {
  assert.equal(getKaggleAvailability().available, false);
});
