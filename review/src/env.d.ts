// Modules the review app imports from the project (Vite's root) and from the plugin.

declare module "virtual:in-ctrl-review" {
  const config: unknown;
  export default config;
}

declare module "virtual:in-ctrl-review-client" {}

declare module "/generated/*" {
  const value: any;
  export default value;
}
