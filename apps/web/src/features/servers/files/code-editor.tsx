import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import type { EditorLanguage } from "./paths";

/*
 * CodeMirror 6 editor (lazy-loaded chunk: only fetched when a file is opened). Content is set as
 * editor text, never parsed as HTML. Theme colours come from the app's CSS variables.
 */

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--card)", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 60%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--primary) 30%, transparent) !important",
  },
  ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 35%, transparent)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null], color: "var(--chart-7)" },
  { tag: [t.string, t.special(t.string)], color: "var(--chart-6)" },
  { tag: [t.number], color: "var(--chart-2)" },
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: "var(--chart-1)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.heading, t.typeName], color: "var(--chart-4)" },
]);

function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "properties":
      return StreamLanguage.define(properties);
    case "toml":
      return StreamLanguage.define(toml);
    case "shell":
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: EditorLanguage;
  readOnly: boolean;
  onSave?: () => void;
  ariaLabel: string;
}

export default function CodeEditor({
  value,
  onChange,
  language,
  readOnly,
  onSave,
  ariaLabel,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          languageExtension(language),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          readOnlyComp.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The document is re-created only when the language changes; text updates go through `value` below.
  }, [language, ariaLabel]);

  // External value changes (reload from disk) replace the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyComp.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
