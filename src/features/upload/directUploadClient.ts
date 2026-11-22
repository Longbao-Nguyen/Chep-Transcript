import { uploadPresigned } from '@vercel/blob/client';

export async function uploadMediaObject(input: {
  jobId: string;
  pathname: string;
  file: File;
  contentType: string;
  onProgress(progress: number): void;
}): Promise<void> {
  const uploaded = await uploadPresigned(input.pathname, input.file, {
    access: 'private',
    contentType: input.contentType,
    handleUploadUrl: '/api/uploads/direct',
    clientPayload: JSON.stringify({ jobId: input.jobId }),
    multipart: true,
    onUploadProgress: ({ loaded, total }) => {
      if (total > 0) input.onProgress(Math.min(loaded / total, 1));
    },
  });

  if (uploaded.pathname !== input.pathname) {
    throw new Error('Object storage returned an unexpected pathname.');
  }
}
