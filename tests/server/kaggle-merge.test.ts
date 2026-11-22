import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUAL_THRESHOLD_SECONDS,
  formatTranscripts,
  mergeSegments,
  shardRanges,
} from '../../server/kaggle/merge';

test('shardRanges requires >= 21 minutes and builds a 5-second overlap around midpoint', () => {
  assert.throws(() => shardRanges(DUAL_THRESHOLD_SECONDS - 1));
  const spans = shardRanges(1400);
  assert.deepEqual(spans, [
    [0, 702.5],
    [697.5, 1400],
  ]);
});

test('mergeSegments converts shard times to global time and deduplicates >= 4-word exact overlapping prefix', () => {
  const spans = shardRanges(1400);
  const shard0 = [
    { start: 0, end: 10, text: 'Bonjour à tous et bienvenue.' },
    { start: 697.6, end: 702.3, text: 'Nous allons maintenant étudier le chapitre suivant ensemble.' },
  ];
  const shard1 = [
    { start: 0.2, end: 5.5, text: 'étudier le chapitre suivant ensemble, puis nous ferons un exercice.' },
    { start: 10, end: 20, text: 'Merci de votre attention.' },
  ];

  const { segments, removedCount } = mergeSegments([shard0, shard1], spans);
  assert.equal(removedCount, 1);
  assert.equal(segments.length, 4);
  assert.equal(segments[1].start, 697.6);
  assert.equal(segments[2].start, 697.7);
  assert.equal(segments[2].text, 'puis nous ferons un exercice.');
  assert.equal(segments[3].start, 707.5);

  const formatted = formatTranscripts(segments);
  assert.match(formatted.txt, /^\[00:00:00 - 00:00:10\] Bonjour à tous et bienvenue\./m);
  assert.match(formatted.srt, /^1\n00:00:00,000 --> 00:00:10,000\nBonjour à tous et bienvenue\./m);
});
