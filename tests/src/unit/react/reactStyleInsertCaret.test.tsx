import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultStyleSpecs,
} from "@blocknote/core";
import { BlockNoteViewRaw, createReactStyleSpec } from "@blocknote/react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

/**
 * Regression tests for #3064.
 *
 * Inserting a React style (`createReactStyleSpec`) creates a TipTap mark view.
 * `ReactRenderer` only flushSyncs that portal when
 * `isEditorContentInitialized` is true. If the flag is unset, the portal is
 * deferred to a microtask, ProseMirror's `selectionToDOM` runs too early, and
 * the DOM caret stays at the start of the paragraph while PM selection is
 * after the insert. Native typing then prepends.
 */

const highlight = createReactStyleSpec(
  {
    type: "highlight",
    propSchema: "boolean",
  },
  {
    render: (props) => {
      return <mark ref={props.contentRef} />;
    },
  },
);

const schema = BlockNoteSchema.create({
  styleSpecs: {
    ...defaultStyleSpecs,
    highlight,
  },
});

type TestEditor = BlockNoteEditor<
  typeof schema.blockSchema,
  typeof schema.inlineContentSchema,
  typeof schema.styleSchema
>;

let root: Root | undefined;
let div: HTMLDivElement | undefined;
let editor: TestEditor | undefined;

/**
 * Insert `text` at the browser DOM caret, the way contenteditable does when
 * ProseMirror leaves a keypress unprevented (normal collapsed text
 * selections). This is the #3064 failure mode: PM selection can be correct
 * while the DOM caret is not.
 */
function typeAtDomCaret(text: string) {
  const view = editor!.prosemirrorView;
  if (!view) {
    throw new Error("expected a mounted ProseMirror view");
  }

  for (const char of text) {
    const keypress = new KeyboardEvent("keypress", {
      key: char,
      charCode: char.charCodeAt(0),
      bubbles: true,
      cancelable: true,
    });
    const prevented = !view.dom.dispatchEvent(keypress);
    if (prevented) {
      continue;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      throw new Error("expected a DOM caret");
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(char);
    range.insertNode(node);
    range.setStart(node, node.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ProseMirror's MutationObserver maps the DOM edit back into the document.
  (view as any).domObserver.flush();
}

function mountEditor(): TestEditor {
  div = document.createElement("div");
  document.body.appendChild(div);

  editor = BlockNoteEditor.create({
    schema,
    trailingBlock: false,
    initialContent: [
      {
        type: "paragraph",
        content: "",
      },
    ],
  }) as TestEditor;

  root = createRoot(div);
  flushSync(() => {
    root!.render(
      <BlockNoteViewRaw
        editor={editor!}
        formattingToolbar={false}
        linkToolbar={false}
        sideMenu={false}
        slashMenu={false}
        emojiPicker={false}
        filePanel={false}
        tableHandles={false}
        comments={false}
      />,
    );
  });

  return editor;
}

afterEach(() => {
  root?.unmount();
  root = undefined;
  if (div) {
    document.body.removeChild(div);
    div = undefined;
  }
  editor?._tiptapEditor.destroy();
  editor = undefined;
});

describe("React style insertInlineContent caret (#3064)", () => {
  it("sets isEditorContentInitialized on mount and clears it on unmount", () => {
    const ed = mountEditor();
    expect(ed._tiptapEditor.isEditorContentInitialized).toBe(true);

    root!.unmount();
    root = undefined;
    expect(ed._tiptapEditor.isEditorContentInitialized).toBe(false);
  });

  it("appends typed text after a React style insert without re-clicking", () => {
    const ed = mountEditor();

    ed.focus();
    ed.setTextCursorPosition(ed.document[0], "start");
    ed.insertInlineContent([
      {
        type: "text",
        text: "Styled text",
        styles: { highlight: true },
      },
    ]);

    const view = ed.prosemirrorView;
    if (!view) {
      throw new Error("expected a mounted ProseMirror view");
    }

    // PM selection is after the insert even without the flag; the bug is that
    // the DOM caret is not.
    expect(view.state.selection.from).toBe(view.state.selection.to);
    expect(view.state.doc.textBetween(0, view.state.doc.content.size)).toBe(
      "Styled text",
    );

    const domSelection = window.getSelection();
    expect(domSelection?.anchorNode).toBeTruthy();
    const domPos = view.posAtDOM(
      domSelection!.anchorNode!,
      domSelection!.anchorOffset,
    );
    expect(domPos).toBe(view.state.selection.from);

    typeAtDomCaret(" continued");

    expect(view.state.doc.textBetween(0, view.state.doc.content.size)).toBe(
      "Styled text continued",
    );
  });
});
