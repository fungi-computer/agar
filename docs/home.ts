import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { buildAppApi } from "@fungi.computer/agar/backend-declaration";

const notes = new Map<string, string>();
const appBackend = defineAppBackend({
  methods: {
    saveNote: defineAppMethod({
      description: "Save a note under a title",
      effect: "write",
      requires: [],
      input: z.object({ title: z.string().min(1), text: z.string() }),
      output: z.object({ saved: z.boolean() }),
      handler: ({ title, text }) => {
        notes.set(title, text);
        return { saved: true };
      },
    }),
  },
});

const api = buildAppApi(appBackend);
console.log(Object.keys(api.methods)); // ["saveNote"]

const result = await appBackend.call(
  "saveNote",
  { title: "hello", text: "from Agar" },
  undefined,
  { computerId: null, actor: { kind: "member", memberId: "member_example" } },
);
console.log(result); // { saved: true }
