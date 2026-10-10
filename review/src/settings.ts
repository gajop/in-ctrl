// The review app's settings from the project's in-ctrl.config.yaml (`title`
// and the `review` section), passed in by the Vite plugin (src/node/review/vite.mjs).

import config from "virtual:in-ctrl-review";

export const settings = config as {
  /** The sidebar's title. */
  title: string;
  /** The project's name in maps ("what … is made of"). */
  name: string;
  /** Where this browser keeps view settings and drafts in localStorage. */
  storageKey: string;
  /** Where map boxes and flows without a doc of their own link. */
  mapsPage: string;
  /** The branch approved branches merge into. */
  baseBranch: string;
};
