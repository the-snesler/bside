import { useEffect, useState } from "preact/hooks";
import X from "~icons/tabler/x";
import FileIcon from "~icons/tabler/file";
import FileText from "~icons/tabler/file-text";
import FilePdf from "~icons/tabler/file-type-pdf";
import Photo from "~icons/tabler/photo";
import AlertCircle from "~icons/tabler/alert-circle";
import type { AttachmentRefV1 } from "@/lib/domain/attachments";
import type { MarkdownImages } from "@/lib/ui/Markdown";
import { describeFileType, formatBytes, imageThumbnail, isViewableImage, type PendingFile } from "@/lib/ui/attachments";

function TypeIcon({ mimeType, text }: { mimeType: string; text: boolean }) {
  if (mimeType.startsWith("image/")) return <Photo aria-hidden="true" />;
  if (mimeType === "application/pdf") return <FilePdf aria-hidden="true" />;
  if (text || mimeType.startsWith("text/")) return <FileText aria-hidden="true" />;
  return <FileIcon aria-hidden="true" />;
}

function Thumb({ src, mimeType, text }: { src: string | null; mimeType: string; text: boolean }) {
  return <span class="file-chip__thumb">{src ? <img src={src} alt="" /> : <TypeIcon mimeType={mimeType} text={text} />}</span>;
}

/** A small thumbnail drawn from the local file, for an image the user has not sent yet. */
function useLocalThumbnail(file: File, mimeType: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!isViewableImage(mimeType || file.type)) return;
    let live = true;
    void imageThumbnail(file).then((url) => { if (live) setSrc(url); });
    return () => { live = false; };
  }, [file, mimeType]);
  return src;
}

/** A file waiting in the composer: name, size, a thumbnail for an image, and its upload or error state. Names render as text. */
export function PendingFileChip({ item, onRemove }: { item: PendingFile; onRemove: () => void }) {
  const thumbnail = useLocalThumbnail(item.file, item.mimeType);
  const busy = item.status === "waiting" || item.status === "uploading";
  const failed = item.status === "failed";
  return (
    <li class={`file-chip${failed ? " file-chip--failed" : ""}${busy ? " file-chip--busy" : ""}`} title={item.name} aria-busy={busy}>
      {failed ? <span class="file-chip__thumb"><AlertCircle aria-hidden="true" /></span> : <Thumb src={thumbnail} mimeType={item.mimeType} text={false} />}
      <span class="file-chip__text">
        <span class="file-chip__name">{item.name}</span>
        <small class="file-chip__meta" role={failed ? "alert" : undefined}>
          {failed ? item.error : busy ? `Attaching… · ${formatBytes(item.bytes)}` : formatBytes(item.bytes)}
        </small>
      </span>
      <button type="button" class="file-chip__remove" aria-label={`Remove ${item.name}`} title="Remove" onClick={onRemove}><X /></button>
    </li>
  );
}

/** A thumbnail of an attached image in the open chat's `/workspace/uploads`, loaded with `workspace.image`. */
function useWorkspaceThumbnail(ref: AttachmentRefV1, images: MarkdownImages | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const viewable = isViewableImage(ref.mimeType);
  useEffect(() => {
    setSrc(null);
    if (!viewable || !images) return;
    let live = true;
    void images.load(images.sessionId, ref.path).then((reply) => {
      if (live && reply.ok && reply.mimeType.startsWith("image/")) setSrc(`data:${reply.mimeType};base64,${reply.data}`);
    });
    return () => { live = false; };
  }, [viewable, images?.sessionId, images?.load, ref.path]);
  return src;
}

/** A file sent with a message (on the transcript, a steer, or a queued message): name, type, and size; images get a thumbnail from the chat's workspace. */
export function AttachmentRefChip({ attachment, images }: { attachment: AttachmentRefV1; images?: MarkdownImages }) {
  const thumbnail = useWorkspaceThumbnail(attachment, images);
  const type = describeFileType(attachment.mimeType, attachment.name, attachment.text);
  return (
    <li class="file-chip" title={`${attachment.name}\n${attachment.path}`}>
      <Thumb src={thumbnail} mimeType={attachment.mimeType} text={attachment.text} />
      <span class="file-chip__text">
        <span class="file-chip__name">{attachment.name}</span>
        <small class="file-chip__meta">{type} · {formatBytes(attachment.bytes)}</small>
      </span>
    </li>
  );
}

/** The files a sent or queued message carries. */
export function AttachmentRefChips({ attachments, images, compact = false }: { attachments?: AttachmentRefV1[]; images?: MarkdownImages; compact?: boolean }) {
  if (!attachments?.length) return null;
  return (
    <ul class={`file-chips${compact ? " file-chips--compact" : ""}`} aria-label="Attached files">
      {attachments.map((attachment) => <AttachmentRefChip key={attachment.path} attachment={attachment} images={images} />)}
    </ul>
  );
}
