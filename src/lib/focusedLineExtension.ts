// Adds a `focused` attribute to listItem/taskItem (rendered as data-focused for
// CSS) and a command to set it on the node at a ProseMirror position (used by
// the drop zone under the timer). Clearing/done-marking happen as pure JSON
// transforms in focusedLine.ts — this extension is only what MUST live in the
// editor: the schema attribute and the pos-addressed drop command.
import { Extension } from "@tiptap/react";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    focusedLine: {
      /** Set `focused` on the listItem/taskItem at pos; clear it everywhere else. */
      setFocusedLineAt: (pos: number) => ReturnType;
    };
  }
}

const TYPES = ["listItem", "taskItem"];

export const FocusedLine = Extension.create({
  name: "focusedLine",

  addGlobalAttributes() {
    return [
      {
        types: TYPES,
        attributes: {
          focused: {
            default: false,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-focused") === "true",
            renderHTML: (attrs) => (attrs.focused ? { "data-focused": "true" } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFocusedLineAt:
        (pos) =>
        ({ tr, state, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || !TYPES.includes(node.type.name)) return false;
          if (dispatch) {
            state.doc.descendants((n, p) => {
              if (TYPES.includes(n.type.name) && n.attrs.focused && p !== pos) {
                tr.setNodeMarkup(p, undefined, { ...n.attrs, focused: false });
              }
            });
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, focused: true });
          }
          return true;
        },
    };
  },
});
