// Wrangler bundles `.html` files as text, so they can be imported as strings.
declare module '*.html' {
  const content: string;
  export default content;
}
