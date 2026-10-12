/**
 * Save text as a file. The anchor must be attached to the document for Firefox to honour the
 * click; the object URL is revoked shortly after.
 */
export function downloadText(fileName: string, text: string, type = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
