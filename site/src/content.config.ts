// The docs collection: the project's Markdown, staged by in-ctrl
// (src/node/stage.mjs) into a working folder outside this package.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

const content = process.env.IN_CTRL_CONTENT;
if (!content) throw new Error("IN_CTRL_CONTENT is not set; build the site with `in-ctrl site build`.");

export const collections = {
  docs: defineCollection({ loader: glob({ base: `${content}/docs`, pattern: "**/[^_]*.md" }), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
