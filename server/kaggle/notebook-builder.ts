import { HttpError } from '../http/responses.js';
import { DUAL_THRESHOLD_SECONDS } from './merge.js';

export interface NotebookModelFileSpec {
  size: number;
  sha256: string;
}

export interface NotebookModelConfig {
  model: string;
  ct2Model: string;
  kaggleDataset: string;
  revision: string;
  chunkSeconds: number;
  sweetSpot: {
    computeType: string;
    concurrency: number;
  };
  transcribe: {
    beamSize: number;
    vadFilter: boolean;
    conditionOnPreviousText: boolean;
  };
  files?: Record<string, NotebookModelFileSpec>;
}

export interface BuildTranscriptionNotebookInput {
  jobId: string;
  workerRunId: string;
  language: string;
  model: NotebookModelConfig;
  audioDownloadUrl: string;
  callbackBaseUrl: string;
  callbackToken: string;
  shardIndex?: 0 | 1;
  span?: [number, number] | null;
}

function assertHttpUrl(value: string, label: string, stripTrailingSlash = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `${label} must be a valid URL.`, 'INVALID_NOTEBOOK_CONFIG');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(400, `${label} must use HTTP or HTTPS.`, 'INVALID_NOTEBOOK_CONFIG');
  }
  const formatted = parsed.toString();
  return stripTrailingSlash ? formatted.replace(/\/+$/, '') : formatted;
}

function pyJsonLiteral(value: unknown): string {
  return `json.loads(${JSON.stringify(JSON.stringify(value))})`;
}

const WORKER_TEMPLATE = `
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ["HF_HUB_DISABLE_XET"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


class CancelledByUser(Exception):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(8 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def stamp(seconds: float, srt: bool = False) -> str:
    millis = max(0, round(seconds * 1000))
    whole, ms = divmod(millis, 1000)
    hours, rest = divmod(whole, 3600)
    minutes, sec = divmod(rest, 60)
    base = f"{hours:02}:{minutes:02}:{sec:02}"
    return f"{base},{ms:03}" if srt else base


def callback_request(method: str, action: str, payload=None):
    url = f"{CALLBACK_BASE_URL}/api/internal/jobs/{JOB_ID}/{action}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": f"Bearer {CALLBACK_TOKEN}",
        "Accept": "application/json",
        "User-Agent": "chep-kaggle-worker/1",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=45) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def check_cancel():
    try:
        state = callback_request("GET", "cancel-state")
    except urllib.error.HTTPError as err:
        if err.code in (401, 403):
            raise CancelledByUser("Callback authorization expired or job already terminated.")
        raise
    if state.get("shouldCancel"):
        raise CancelledByUser("Cancellation requested by user.")


def install_dependencies():
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "faster-whisper==1.2.1", "ctranslate2==4.8.2"],
        check=True,
    )


def verify_t4_gpu():
    gpu = subprocess.check_output(
        ["nvidia-smi", "--id=0", "--query-gpu=name", "--format=csv,noheader"],
        text=True,
    ).strip()
    if "T4" not in gpu and not gpu:
        raise RuntimeError("No GPU device detected.")
    return gpu


def locate_model_dir() -> Path:
    for candidate in Path("/kaggle/input").rglob("model.bin"):
        directory = candidate.parent
        if not MODEL_FILES:
            return directory
        matched = True
        for filename, meta in MODEL_FILES.items():
            file_path = directory / filename
            if not file_path.is_file() or file_path.stat().st_size != meta["size"]:
                matched = False
                break
            if sha256_file(file_path) != meta["sha256"]:
                matched = False
                break
        if matched:
            return directory
    raise RuntimeError("Pinned Kaggle model dataset files were not found or failed verification.")


def download_source(target: Path):
    req = urllib.request.Request(AUDIO_DOWNLOAD_URL, headers={"User-Agent": "chep-kaggle-worker/1"})
    with urllib.request.urlopen(req, timeout=180) as resp, target.open("wb") as out:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)


def normalize_to_wav(source: Path, target: Path) -> float:
    import av

    with av.open(str(source)) as container, wave.open(str(target), "wb") as output:
        if not container.streams.audio:
            raise ValueError("This file has no audio stream.")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        sample_count = 0
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                data = converted.to_ndarray().tobytes()
                output.writeframesraw(data)
                sample_count += len(data) // 2
        for converted in resampler.resample(None):
            data = converted.to_ndarray().tobytes()
            output.writeframesraw(data)
            sample_count += len(data) // 2
    if sample_count == 0:
        raise ValueError("The audio file is empty.")
    return sample_count / 16000.0


def select_range(audio: Path, start: float, stop: float, source_duration: float) -> float:
    if (
        not all(math.isfinite(val) for val in (start, stop, source_duration))
        or not 0 <= start < stop <= source_duration + 0.001
    ):
        raise ValueError("Invalid audio shard range.")
    full = audio.with_name("full.wav")
    audio.replace(full)
    low = round(start * 16000)
    high = min(round(stop * 16000), round(source_duration * 16000))
    with wave.open(str(full), "rb") as original, wave.open(str(audio), "wb") as selected:
        selected.setparams(original.getparams())
        original.setpos(low)
        remaining = high - low
        while remaining > 0:
            frames = original.readframes(min(remaining, 16000 * 60))
            if not frames:
                raise ValueError("Decoded audio ended before shard range.")
            selected.writeframesraw(frames)
            remaining -= len(frames) // 2
    full.unlink(missing_ok=True)
    return (high - low) / 16000.0


def main():
    work = Path("/tmp/chep")
    work.mkdir(parents=True, exist_ok=True)
    source_path = work / "source.media"
    wav_path = work / "audio.wav"

    try:
        check_cancel()
        install_dependencies()
        verify_t4_gpu()
        model_dir = locate_model_dir()

        callback_request("POST", "progress", {"status": "PREPROCESSING", "progress": 0.03})
        check_cancel()
        download_source(source_path)
        check_cancel()
        source_duration = normalize_to_wav(source_path, wav_path)
        source_path.unlink(missing_ok=True)

        active_span = SPAN
        active_shard_index = SHARD_INDEX
        if active_span is None and source_duration >= DUAL_THRESHOLD_SECONDS:
            try:
                plan = callback_request("POST", "plan", {"durationSec": source_duration})
                if plan.get("dual") and plan.get("span"):
                    active_span = plan["span"]
                    active_shard_index = 0
            except Exception:
                active_span = None

        duration_sec = (
            select_range(wav_path, active_span[0], active_span[1], source_duration)
            if active_span is not None
            else source_duration
        )

        import numpy as np
        from faster_whisper import WhisperModel

        callback_request(
            "POST",
            "progress",
            {"status": "TRANSCRIBING", "progress": 0.08, "durationSec": source_duration, "processedAudioSec": 0},
        )
        check_cancel()

        model = WhisperModel(
            str(model_dir),
            device="cuda",
            compute_type=COMPUTE_TYPE,
            device_index=0,
            num_workers=CONCURRENCY,
            cpu_threads=4,
            local_files_only=True,
        )

        collected_segments = []

        def infer(item):
            offset, chunk = item
            segments, _ = model.transcribe(
                chunk,
                language=LANGUAGE,
                task="transcribe",
                beam_size=TRANSCRIBE_OPTS["beamSize"],
                vad_filter=TRANSCRIBE_OPTS["vadFilter"],
                condition_on_previous_text=TRANSCRIBE_OPTS["conditionOnPreviousText"],
            )
            return [
                {
                    "start": min(duration_sec, offset + seg.start),
                    "end": min(duration_sec, offset + seg.end),
                    "text": seg.text.strip(),
                }
                for seg in segments
                if seg.text.strip()
            ]

        with wave.open(str(wav_path), "rb") as wav, ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            chunk_idx = 0
            while True:
                check_cancel()
                batch = []
                for _ in range(CONCURRENCY):
                    frames = wav.readframes(CHUNK_SECONDS * 16000)
                    if not frames:
                        break
                    audio_arr = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
                    batch.append((chunk_idx * CHUNK_SECONDS, audio_arr))
                    chunk_idx += 1
                if not batch:
                    break
                for chunk_segments in pool.map(infer, batch):
                    collected_segments.extend(chunk_segments)
                processed = min(duration_sec, float(chunk_idx * CHUNK_SECONDS))
                progress = min(0.95, 0.08 + 0.87 * (processed / max(duration_sec, 1.0)))
                callback_request(
                    "POST",
                    "progress",
                    {
                        "status": "TRANSCRIBING",
                        "progress": progress,
                        "durationSec": source_duration,
                        "processedAudioSec": processed,
                    },
                )

        check_cancel()
        if active_span is not None:
            callback_request(
                "POST",
                "shard",
                {
                    "shardIndex": active_shard_index if active_shard_index is not None else 0,
                    "segments": collected_segments,
                    "durationSec": source_duration,
                },
            )
            return

        callback_request(
            "POST",
            "progress",
            {"status": "FINALIZING", "progress": 0.98, "durationSec": source_duration, "processedAudioSec": source_duration},
        )
        check_cancel()
        transcript_text = "".join(
            f"[{stamp(s['start'])} - {stamp(s['end'])}] {s['text']}\\n" for s in collected_segments
        )
        subtitle_srt = "".join(
            f"{idx}\\n{stamp(s['start'], True)} --> {stamp(s['end'], True)}\\n{s['text']}\\n\\n"
            for idx, s in enumerate(collected_segments, 1)
        )
        callback_request(
            "POST",
            "complete",
            {
                "transcriptText": transcript_text,
                "subtitleSrt": subtitle_srt,
                "durationSec": source_duration,
                "processedAudioSec": source_duration,
            },
        )
    except CancelledByUser:
        try:
            callback_request("POST", "cancelled", {})
        except Exception:
            pass
    except Exception as exc:
        try:
            callback_request(
                "POST",
                "fail",
                {
                    "errorCode": "FAILED_INFERENCE",
                    "errorMessage": str(exc)[:500],
                },
            )
        except Exception:
            pass
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
`;

function toNotebookDocument(source: string, cellId: string): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
    },
    cells: [
      {
        id: cellId,
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: source.split('\n').map((line, index, arr) => (index < arr.length - 1 ? `${line}\n` : line)),
      },
    ],
  };
}

export function buildTranscriptionNotebook(input: BuildTranscriptionNotebookInput): Record<string, unknown> {
  if (!input.jobId || !input.workerRunId || !input.callbackToken) {
    throw new HttpError(400, 'Job ID, worker run ID, and callback token are required.', 'INVALID_NOTEBOOK_CONFIG');
  }
  const audioUrl = assertHttpUrl(input.audioDownloadUrl, 'audioDownloadUrl');
  const callbackBase = assertHttpUrl(input.callbackBaseUrl, 'callbackBaseUrl', true);

  const headerLines = [
    'import json',
    `JOB_ID = ${JSON.stringify(input.jobId)}`,
    `WORKER_RUN_ID = ${JSON.stringify(input.workerRunId)}`,
    `LANGUAGE = ${JSON.stringify(input.language)}`,
    `MODEL_ID = ${JSON.stringify(input.model.model)}`,
    `MODEL_REVISION = ${JSON.stringify(input.model.revision)}`,
    `CHUNK_SECONDS = ${JSON.stringify(input.model.chunkSeconds)}`,
    `COMPUTE_TYPE = ${JSON.stringify(input.model.sweetSpot.computeType)}`,
    `CONCURRENCY = ${JSON.stringify(input.model.sweetSpot.concurrency)}`,
    `TRANSCRIBE_OPTS = ${pyJsonLiteral(input.model.transcribe)}`,
    `MODEL_FILES = ${pyJsonLiteral(input.model.files ?? {})}`,
    `AUDIO_DOWNLOAD_URL = ${JSON.stringify(audioUrl)}`,
    `CALLBACK_BASE_URL = ${JSON.stringify(callbackBase)}`,
    `CALLBACK_TOKEN = ${JSON.stringify(input.callbackToken)}`,
    `DUAL_THRESHOLD_SECONDS = ${JSON.stringify(DUAL_THRESHOLD_SECONDS)}`,
    `SHARD_INDEX = ${input.shardIndex === undefined ? 'None' : String(input.shardIndex)}`,
    `SPAN = ${input.span ? pyJsonLiteral(input.span) : 'None'}`,
  ].join('\n');

  const source = `${headerLines}\n${WORKER_TEMPLATE.trimStart()}`;
  return toNotebookDocument(source, 'chep-transcribe');
}

export function buildGpuProbeNotebook(): Record<string, unknown> {
  const probeScript = [
    'import json, subprocess',
    "gpu = subprocess.check_output(['nvidia-smi', '--id=0', '--query-gpu=name', '--format=csv,noheader'], text=True).strip()",
    "if 'T4' not in gpu:",
    "    raise RuntimeError('Requested T4 GPU was not assigned: ' + gpu)",
    "with open('/kaggle/working/gpu-check.json', 'w', encoding='utf-8') as f:",
    "    json.dump({'gpu': gpu}, f)",
  ].join('\n');
  return toNotebookDocument(probeScript, 'chep-gpu-check');
}
