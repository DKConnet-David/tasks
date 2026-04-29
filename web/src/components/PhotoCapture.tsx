import { useRef, useState } from "react";

export interface CapturedPhoto {
  file: File;
  previewUrl: string;
  id: string;
}

interface Props {
  photos: CapturedPhoto[];
  onChange: (next: CapturedPhoto[]) => void;
  max?: number;
  disabled?: boolean;
}

const DEFAULT_MAX = 50;

export function PhotoCapture({ photos, onChange, max = DEFAULT_MAX, disabled }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function handlePicked(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // reset so picking the same file again still fires onChange
    if (files.length === 0) return;

    const remaining = max - photos.length;
    const accepted: CapturedPhoto[] = [];
    let nonImage = 0;
    let overLimit = 0;
    for (const f of files) {
      if (!f.type.startsWith("image/")) {
        nonImage += 1;
        continue;
      }
      if (accepted.length >= remaining) {
        overLimit += 1;
        continue;
      }
      accepted.push({
        id: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`,
        file: f,
        previewUrl: URL.createObjectURL(f),
      });
    }
    const messages: string[] = [];
    if (nonImage > 0) {
      messages.push(`${nonImage} non-image file${nonImage === 1 ? "" : "s"} skipped.`);
    }
    if (overLimit > 0) {
      messages.push(`${overLimit} skipped — already at the ${max}-photo limit.`);
    }
    setError(messages.length > 0 ? messages.join(" ") : null);
    onChange([...photos, ...accepted]);
  }

  function remove(id: string) {
    const next = photos.filter((p) => p.id !== id);
    const removed = photos.find((p) => p.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    onChange(next);
  }

  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || photos.length >= max}
        >
          Take photo
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => galleryRef.current?.click()}
          disabled={disabled || photos.length >= max}
        >
          Pick from gallery
        </button>
        <span className="muted">
          {photos.length} / {max}
        </span>
      </div>

      {/* Hidden inputs. capture="environment" hints the back camera on mobile. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handlePicked}
        style={{ display: "none" }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handlePicked}
        style={{ display: "none" }}
      />

      {error && <div className="warn">{error}</div>}

      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: 8,
          }}
        >
          {photos.map((p) => (
            <div
              key={p.id}
              style={{
                position: "relative",
                aspectRatio: "1 / 1",
                borderRadius: "var(--r)",
                overflow: "hidden",
                background: "#000",
              }}
            >
              <img
                src={p.previewUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <button
                type="button"
                onClick={() => remove(p.id)}
                disabled={disabled}
                aria-label="Remove photo"
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  padding: "0 8px",
                  background: "rgba(0,0,0,0.7)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.3)",
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
