import { CSRF_HEADER, REQUEST_ID_HEADER } from "@blockforge/contracts";
import { apiClient, newIdempotencyKey } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { filesApi } from "@/lib/api/files-api";

export interface UploadProgress {
  id: string;
  name: string;
  size: number;
  loaded: number;
  status: "pending" | "uploading" | "done" | "error" | "cancelled";
  error?: string;
}

/** Same-origin check for transfer URLs returned by the API (never send cookies elsewhere). */
export function isSameOriginUrl(url: string, origin = window.location.origin): boolean {
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Upload one file: ask for a single-use transfer URL, then stream the body with progress.
 * Resolves on 2xx; rejects with an ApiError otherwise. `signal` aborts the transfer.
 */
export async function uploadFile(
  serverId: string,
  directory: string,
  file: File,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { url } = await filesApi.uploadUrl(serverId, { directory, fileName: file.name, size: file.size });
  await putToTransferUrl(url, file, onProgress, signal);
}

/**
 * PUT `body` to a single-use, same-origin transfer URL with progress (the session cookie and CSRF
 * header authorise it). Rejects with an ApiError on non-2xx, refuses other origins.
 */
export async function putToTransferUrl(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!isSameOriginUrl(url)) {
    throw new ApiError({
      code: "INVALID_RESPONSE",
      message: "The upload URL points to another site; refusing.",
      status: 0,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const requestId = newIdempotencyKey();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader(REQUEST_ID_HEADER, requestId);
    const csrf = apiClient.getCsrfToken();
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(body.size);
        resolve();
        return;
      }
      let message = `Upload failed (HTTP ${xhr.status}).`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        /* not JSON */
      }
      reject(
        new ApiError({
          code: xhr.status === 403 ? "FORBIDDEN" : "UPSTREAM_ERROR",
          message,
          status: xhr.status,
          requestId,
        }),
      );
    };
    xhr.onerror = () =>
      reject(
        new ApiError({ code: "NETWORK_ERROR", message: "The upload was interrupted.", status: 0, requestId }),
      );
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** Start a browser download through a single-use URL (the session cookie authorises it). */
export async function downloadFile(serverId: string, path: string, fileName: string): Promise<void> {
  const { url } = await filesApi.downloadUrl(serverId, path);
  if (!isSameOriginUrl(url))
    throw new ApiError({ code: "INVALID_RESPONSE", message: "Unexpected download URL.", status: 0 });
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
