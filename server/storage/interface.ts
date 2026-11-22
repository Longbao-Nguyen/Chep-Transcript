export interface StoredObjectMetadata {
  pathname: string;
  size: number;
  contentType: string;
  etag: string;
}

export interface PrivateStoredObject extends StoredObjectMetadata {
  stream: ReadableStream<Uint8Array>;
}

export interface DirectUploadRequest {
  pathname: string;
  clientPayload: string | null;
  multipart: boolean;
}

export interface DirectUploadGrant {
  contentType: string;
  maximumSizeInBytes: number;
  validUntil: number;
}

export type AuthorizeDirectUpload = (request: DirectUploadRequest) => Promise<DirectUploadGrant>;

export interface ObjectStorage {
  assertConfigured(): void;
  handleDirectUploadRequest(
    body: unknown,
    authorize: AuthorizeDirectUpload,
  ): Promise<unknown>;
  headObject(pathname: string): Promise<StoredObjectMetadata | null>;
  getPrivateObject(pathname: string): Promise<PrivateStoredObject | null>;
  putPrivateObject(
    pathname: string,
    body: string | Buffer | Uint8Array,
    contentType: string,
  ): Promise<StoredObjectMetadata>;
  createSignedDownloadUrl(pathname: string, expiresInMs: number): Promise<string>;
  deleteObject(pathname: string): Promise<void>;
}
