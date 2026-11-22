export function createDownloadFilename(originalFilename: string, extension: 'txt' | 'srt' = 'txt'): string {
  const withoutExtension = originalFilename.replace(/\.[^.]+$/, '') || 'transcript';
  const safeBase = withoutExtension
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100) || 'transcript';
  return `${safeBase}.${extension}`;
}

export function createTranscriptDownloadFilename(originalFilename: string): string {
  return createDownloadFilename(originalFilename, 'txt');
}

export function attachmentContentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`;
}
