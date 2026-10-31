"""Copy the pinned public model datasets to a Kaggle organization.

Run with the official kaggle Python package and a logged-in Kaggle account.
The source datasets remain untouched. No credential is stored in this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath

from kaggle.api.kaggle_api_extended import KaggleApi


def http_status(error: Exception) -> int | None:
    return getattr(getattr(error, 'response', None), 'status_code', None)


def verify_files(folder: Path, expected: dict) -> None:
    for name, spec in expected.items():
        path = folder / name
        if not path.is_file() or path.stat().st_size != spec['size']:
            raise RuntimeError(f'{path}: missing or wrong size')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != spec['sha256']:
            raise RuntimeError(f'{path}: SHA-256 mismatch')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_destination_bytes(api: KaggleApi, ref: str, source_manifest: dict[str, int],
                             expected: dict, work: Path) -> None:
    destination = work / 'verified-destination'
    destination.mkdir(parents=True, exist_ok=True)
    source_readme = work / 'payload' / 'README.md'
    for name, size in source_manifest.items():
        target = destination / name
        expected_hash = expected.get(name, {}).get('sha256')
        if name == 'README.md' and source_readme.is_file():
            expected_hash = sha256(source_readme)
        if not target.is_file() or target.stat().st_size != size or (expected_hash and sha256(target) != expected_hash):
            api.dataset_download_file(ref + '/1', name, path=str(destination), force=True, quiet=True, unzip=True)
        if not target.is_file() or target.stat().st_size != size:
            raise RuntimeError(f'{ref}: downloaded {name} has wrong size')
        if expected_hash and sha256(target) != expected_hash:
            raise RuntimeError(f'{ref}: downloaded {name} has wrong SHA-256')
    if {item.name: item.stat().st_size for item in destination.iterdir() if item.is_file()} != source_manifest:
        raise RuntimeError(f'{ref}: downloaded destination manifest differs from source')
    print(f'{ref}: destination bytes verified', flush=True)


def extract_source(archive: Path, folder: Path, expected: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    if all((folder / name).is_file() for name in expected):
        try:
            verify_files(folder, expected)
            return
        except RuntimeError:
            pass
    with zipfile.ZipFile(archive) as source:
        members = [member for member in source.infolist() if not member.is_dir()]
        names = {member.filename for member in members}
        if not set(expected).issubset(names):
            raise RuntimeError(f'{archive}: required model files missing')
        if sum(member.file_size for member in members) > 6 * 1024**3:
            raise RuntimeError(f'{archive}: unexpected expanded size')
        for member in members:
            name = PurePosixPath(member.filename)
            if len(name.parts) != 1 or name.name in ('dataset-metadata.json', ''):
                raise RuntimeError(f'{archive}: unsafe or unexpected entry {member.filename!r}')
            destination = folder / name.name
            with source.open(member) as reader, destination.open('wb') as writer:
                shutil.copyfileobj(reader, writer, 8 * 1024 * 1024)
    verify_files(folder, expected)


def file_manifest(api: KaggleApi, ref: str) -> dict[str, int]:
    response = api.dataset_list_files(ref, page_size=100)
    if response.next_page_token:
        raise RuntimeError(f'{ref}: dataset has more than 100 files')
    return {item.name: item.total_bytes for item in response.dataset_files}


def wait_ready(api: KaggleApi, ref: str, timeout: int = 1800) -> None:
    deadline = time.monotonic() + timeout
    transient_errors = 0
    while time.monotonic() < deadline:
        try:
            status = api.dataset_status(ref).lower()
        except Exception as error:
            if http_status(error) not in (403, 404) or transient_errors >= 6:
                raise
            transient_errors += 1
            print(f'{ref}: waiting for metadata visibility', flush=True)
            time.sleep(20)
            continue
        print(f'{ref}: {status}', flush=True)
        if status == 'ready':
            return
        if status == 'error':
            raise RuntimeError(f'{ref}: Kaggle processing failed')
        time.sleep(20)
    raise RuntimeError(f'{ref}: Kaggle processing timed out')


def destination_exists(api: KaggleApi, ref: str) -> bool:
    try:
        api.dataset_status(ref)
        return True
    except Exception as error:
        if http_status(error) in (403, 404):
            return False
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--workdir', type=Path, default=Path(tempfile.gettempdir()) / 'chep-model-migration')
    parser.add_argument('--language', choices=['fr', 'en', 'es', 'de', 'vi'])
    parser.add_argument('--verify-destination-bytes', action='store_true')
    args = parser.parse_args()

    catalog = json.loads(args.catalog.read_text(encoding='utf-8'))['languages']
    api = KaggleApi()
    api.authenticate()
    if api.config_values.get('username') != 'longnj':
        raise RuntimeError('Authenticated Kaggle account must be longnj')

    for language in ([args.language] if args.language else ['fr', 'en', 'es', 'de', 'vi']):
        config = catalog[language]
        source_ref = config['kaggle_dataset']
        owner, slug, version = source_ref.split('/')
        if owner != 'longnj' or version != '1':
            raise RuntimeError(f'{language}: unexpected source reference')
        destination_ref = f'french-transcript/{slug}'
        work = args.workdir / slug
        source_manifest = file_manifest(api, source_ref)
        for name, spec in config['files'].items():
            if source_manifest.get(name) != spec['size']:
                raise RuntimeError(f'{source_ref}: {name} size does not match pinned catalog')

        if destination_exists(api, destination_ref):
            wait_ready(api, destination_ref)
            if file_manifest(api, destination_ref) != source_manifest:
                raise RuntimeError(f'{destination_ref}: existing file manifest differs from source')
            if args.verify_destination_bytes:
                verify_destination_bytes(api, destination_ref, source_manifest, config['files'], work)
            print(f'{destination_ref}: already exists, file manifest matches', flush=True)
            continue

        work.mkdir(parents=True, exist_ok=True)
        archive = work / f'{slug}.zip'
        payload = work / 'payload'
        try:
            verify_files(payload, config['files'])
        except RuntimeError:
            if not archive.is_file() or not zipfile.is_zipfile(archive):
                print(f'{source_ref}: downloading archive', flush=True)
                try:
                    api.dataset_download_files(source_ref, path=str(work), quiet=True)
                except Exception as error:
                    if http_status(error) != 404:
                        raise
                    print(f'{source_ref}: archive unavailable, downloading files', flush=True)
            if archive.is_file() and zipfile.is_zipfile(archive):
                extract_source(archive, payload, config['files'])
            else:
                payload.mkdir(parents=True, exist_ok=True)
                for name in source_manifest:
                    if not (payload / name).is_file() or (payload / name).stat().st_size != source_manifest[name]:
                        api.dataset_download_file(source_ref, name, path=str(payload), quiet=True, unzip=True)
                verify_files(payload, config['files'])
        extracted_manifest = {p.name: p.stat().st_size for p in payload.iterdir() if p.is_file()}
        if extracted_manifest != source_manifest:
            raise RuntimeError(f'{source_ref}: archive file manifest differs from API')
        metadata = {
            'id': destination_ref,
            'title': f'Chep {config["label"]} CTranslate2 model',
            'licenses': [{'name': 'other'}],
            'description': f'Exact copy of public Kaggle dataset {source_ref}. See README.md for original model and license details.',
        }
        (payload / 'dataset-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
        print(f'{destination_ref}: uploading {sum(extracted_manifest.values())} bytes', flush=True)
        result = api.dataset_create_new(str(payload), public=True, quiet=True)
        if result.error:
            raise RuntimeError(f'{destination_ref}: Kaggle create failed: {result.error}')
        wait_ready(api, destination_ref)
        if file_manifest(api, destination_ref) != source_manifest:
            raise RuntimeError(f'{destination_ref}: uploaded file manifest differs from source')
        if args.verify_destination_bytes:
            verify_destination_bytes(api, destination_ref, source_manifest, config['files'], work)
        print(f'{destination_ref}: verified', flush=True)


if __name__ == '__main__':
    main()
