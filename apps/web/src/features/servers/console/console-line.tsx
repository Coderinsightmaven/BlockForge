import { memo } from "react";
import type { CSSProperties } from "react";
import { tokenizeFormatting } from "@blockforge/minecraft";
import type { FormattedSegment, MinecraftColor, TextColor } from "@blockforge/minecraft";
import { formatTime } from "@/lib/format";
import type { ConsoleLine } from "./console-store";

/*
 * Console lines are untrusted. They are split into styled segments by the shared tokenizer
 * (`§` codes + ANSI SGR) and rendered as React text nodes — never as HTML.
 * Colours are tuned for the console's dark background (Minecraft's own values, with the darkest
 * ones lifted so they stay readable).
 */

const MC: Record<MinecraftColor, string> = {
  black: "#6b7280",
  dark_blue: "#5f6cf0",
  dark_green: "#22b14c",
  dark_aqua: "#00b3b3",
  dark_red: "#e04b4b",
  dark_purple: "#c04fc0",
  gold: "#ffaa00",
  gray: "#aaaaaa",
  dark_gray: "#7a7a7a",
  blue: "#7b8bff",
  green: "#55ff55",
  aqua: "#55ffff",
  red: "#ff5555",
  light_purple: "#ff55ff",
  yellow: "#ffff55",
  white: "#ffffff",
};

const ANSI16 = [
  "#6b7280",
  "#e04b4b",
  "#3fbf4a",
  "#d7ba3c",
  "#5f8cf0",
  "#c04fc0",
  "#2fb8c8",
  "#d0d4da",
  "#8b929c",
  "#ff6b6b",
  "#6be26b",
  "#ffe66b",
  "#86a8ff",
  "#ff7bff",
  "#6befff",
  "#ffffff",
];

function ansi256(i: number): string {
  if (i < 16) return ANSI16[i]!;
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const n = i - 16;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}

export function colorCss(color: TextColor | null): string | undefined {
  if (!color) return undefined;
  switch (color.kind) {
    case "minecraft":
      return MC[color.name];
    case "ansi":
      return ansi256(color.index);
    case "rgb":
      // The tokenizer only emits validated #rrggbb values.
      return /^#[0-9a-f]{6}$/i.test(color.hex) ? color.hex : undefined;
  }
}

function segmentStyle(seg: FormattedSegment): CSSProperties | undefined {
  const s = seg.style;
  const color = colorCss(s.color);
  if (!color && !s.bold && !s.italic && !s.underlined && !s.strikethrough) return undefined;
  const decorations = [s.underlined && "underline", s.strikethrough && "line-through"]
    .filter(Boolean)
    .join(" ");
  return {
    color,
    fontWeight: s.bold ? 600 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: decorations || undefined,
  };
}

/** Styled segments of a raw console line (exported for tests). */
export function ConsoleText({ text }: { text: string }) {
  const segments = tokenizeFormatting(text);
  return (
    <>
      {segments.map((seg, i) => {
        const style = segmentStyle(seg);
        // Obfuscated text (§k) is shown as-is; animating it would only distract.
        return style ? (
          <span key={i} style={style}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        );
      })}
    </>
  );
}

export const ConsoleLineView = memo(function ConsoleLineView({
  line,
  showTimestamp,
}: {
  line: ConsoleLine;
  showTimestamp: boolean;
}) {
  return (
    <div
      className={
        line.stream === "system"
          ? "text-[#f0a92a]"
          : line.stream === "stderr"
            ? "text-[#ff8080]"
            : "text-[#d0d4da]"
      }
    >
      {showTimestamp ? <span className="mr-2 text-[#6b7280] select-none">{formatTime(line.ts)}</span> : null}
      {line.stream === "system" ? <span className="mr-1 select-none">[BlockForge]</span> : null}
      <ConsoleText text={line.line} />
    </div>
  );
});
