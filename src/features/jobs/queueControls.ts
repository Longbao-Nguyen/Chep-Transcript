import type { QueueState } from '../../types';

export function queueStartControl(state: QueueState, queuedCount: number, starting: boolean, workerReady: boolean) {
  if (starting) return { disabled: true, label: 'Starting…', reason: 'Starting your queue.' };
  if (state === 'PAUSING') return { disabled: true, label: 'Stopping…', reason: 'Wait for the current transcription to stop.' };
  if (state === 'RUNNING') return { disabled: true, label: 'Running', reason: 'Files are processed one at a time.' };
  if (queuedCount === 0) return { disabled: true, label: 'Start', reason: 'Add a file to the queue first.' };
  if (!workerReady) return { disabled: true, label: state === 'PAUSED' ? 'Resume queue' : 'Start', reason: 'Online GPU is not ready. Your uploaded files will stay in the queue.' };
  return { disabled: false, label: state === 'PAUSED' ? 'Resume queue' : 'Start', reason: 'Start processing queued files in order.' };
}
