export const DUAL_THRESHOLD_SECONDS = 21 * 60;
export const OVERLAP_SECONDS = 5.0;

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const WORD_REGEX = /\p{L}[\p{L}\p{N}_]*|\p{N}+/gu;

export function shardRanges(duration: number): [[number, number], [number, number]] {
  if (!Number.isFinite(duration) || duration < DUAL_THRESHOLD_SECONDS) {
    throw new Error('Dual mode requires audio of at least 21 minutes.');
  }
  const midpoint = duration / 2;
  return [
    [0.0, midpoint + OVERLAP_SECONDS / 2],
    [midpoint - OVERLAP_SECONDS / 2, duration],
  ];
}

function normalizedWords(text: string): Array<{ word: string; endIndex: number }> {
  const result: Array<{ word: string; endIndex: number }> = [];
  for (const match of text.matchAll(WORD_REGEX)) {
    if (match.index === undefined) continue;
    result.push({
      word: match[0].normalize('NFC').toLowerCase(),
      endIndex: match.index + match[0].length,
    });
  }
  return result;
}

function validateShard(
  shard: TranscriptSegment[],
  offset: number,
  stop: number,
  shardIndex: 0 | 1,
): Array<TranscriptSegment & { shard: 0 | 1 }> {
  if (!Array.isArray(shard)) {
    throw new Error('Invalid Kaggle shard segments.');
  }
  const maxLocal = stop - offset + 0.001;
  const validated: Array<TranscriptSegment & { shard: 0 | 1 }> = [];
  for (const item of shard) {
    if (
      !item
      || typeof item !== 'object'
      || typeof item.text !== 'string'
      || !item.text.trim()
      || typeof item.start !== 'number'
      || typeof item.end !== 'number'
      || !Number.isFinite(item.start)
      || !Number.isFinite(item.end)
      || item.start < 0
      || item.start > item.end
      || item.end > maxLocal
    ) {
      throw new Error('Invalid Kaggle shard segment.');
    }
    validated.push({
      start: item.start + offset,
      end: item.end + offset,
      text: item.text.trim(),
      shard: shardIndex,
    });
  }
  return validated;
}

export function mergeSegments(
  shards: [TranscriptSegment[], TranscriptSegment[]],
  spans: [[number, number], [number, number]],
): { segments: TranscriptSegment[]; removedCount: number } {
  const left = validateShard(shards[0], spans[0][0], spans[0][1], 0);
  const right = validateShard(shards[1], spans[1][0], spans[1][1], 1);
  const overlapStart = spans[1][0];
  const overlapEnd = spans[0][1];

  let removedCount = 0;
  const mergedRight: Array<TranscriptSegment & { shard: 0 | 1 }> = [];

  for (const item of right) {
    if (item.start >= overlapEnd || item.end <= overlapStart) {
      mergedRight.push(item);
      continue;
    }

    const rightWords = normalizedWords(item.text);
    const candidates: Array<{ count: number; endIndex: number }> = [];

    for (const old of left) {
      if (old.start > item.start) continue;
      const overlap = Math.min(old.end, item.end, overlapEnd) - Math.max(old.start, item.start, overlapStart);
      if (overlap < 1.0) continue;

      const leftWords = normalizedWords(old.text);
      const maxMatch = Math.min(leftWords.length, rightWords.length, 64);
      for (let count = maxMatch; count >= 4; count -= 1) {
        const leftTail = leftWords.slice(-count).map((entry) => entry.word);
        const rightHead = rightWords.slice(0, count).map((entry) => entry.word);
        if (leftTail.every((word, idx) => word === rightHead[idx])) {
          candidates.push({ count, endIndex: rightWords[count - 1].endIndex });
          break;
        }
      }
    }

    candidates.sort((a, b) => b.count - a.count);
    if (candidates.length === 0 || (candidates.length > 1 && candidates[0].count === candidates[1].count)) {
      mergedRight.push(item);
      continue;
    }

    removedCount += 1;
    const remaining = item.text.slice(candidates[0].endIndex).replace(/^[ \t,.;:!?…\-–—]+/, '');
    if (remaining) {
      mergedRight.push({ ...item, text: remaining });
    }
  }

  const merged = [...left, ...mergedRight].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.shard - b.shard;
  });

  return {
    segments: merged.map(({ start, end, text }) => ({ start, end, text })),
    removedCount,
  };
}

export function formatTimestamp(seconds: number, srt = false): string {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const whole = Math.floor(millis / 1000);
  const ms = millis % 1000;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return srt ? `${base},${String(ms).padStart(3, '0')}` : base;
}

export function formatTranscripts(segments: TranscriptSegment[]): { txt: string; srt: string } {
  const txt = segments
    .map((seg) => `[${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}] ${seg.text}\n`)
    .join('');
  const srt = segments
    .map((seg, idx) => `${idx + 1}\n${formatTimestamp(seg.start, true)} --> ${formatTimestamp(seg.end, true)}\n${seg.text}\n\n`)
    .join('');
  return { txt, srt };
}
