// A project's vocabulary: named building blocks with one label and icon each,
// so "API" looks the same in every diagram. A node or participant that
// says `is: API` gets this label and icon unless it gives its own.
// Projects set it in in-ctrl.config.yaml (`vocabulary:`).

export interface Block {
  label: string;
  icon?: string;
}

export const VOCABULARY: Record<string, Block> = {};

/** Replace the vocabulary (the host calls this once, before drawing). */
export function setVocabulary(blocks: Record<string, Block>) {
  for (const key of Object.keys(VOCABULARY)) delete VOCABULARY[key];
  Object.assign(VOCABULARY, blocks);
}
